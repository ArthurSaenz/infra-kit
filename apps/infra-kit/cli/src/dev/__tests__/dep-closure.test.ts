import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildClosureMap, selectPackageRestartTargets } from 'src/dev/dep-closure'
import type { ClosureMap, DryRunner } from 'src/dev/dep-closure'

import { createTempTracker, makeMonorepo } from './fixtures'

/**
 * Option-B closure map (plan Phase 1): the closure comes from an injected {@link DryRunner}
 * (turbo `--dry` in production), so these tests never spawn turbo. The `packages/*` trees are
 * scaffolded on disk because `buildClosureMap` reads `getPackageDistDirs` + each package.json
 * `name` for the dir↔name bridge.
 */
const temp = createTempTracker()

afterEach(() => {
  temp.cleanup()
})

/** Scaffold `packages/<dir>/dist` + a `package.json` naming the package (dir may differ from name). */
const addPackage = (root: string, dir: string, name: string): string => {
  const distDir = path.join(root, 'packages', dir, 'dist')

  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'packages', dir, 'package.json'), JSON.stringify({ name, type: 'module' }))

  return distDir
}

/** A DryRunner backed by a fixed package-name → closure map. */
const fakeDryRunner = (closures: Record<string, string[]>): DryRunner => {
  return (packageName: string): Promise<string[]> => {
    return Promise.resolve(closures[packageName] ?? [])
  }
}

describe('buildClosureMap — invert per-app closures into dependents-by-package-dir', () => {
  it('maps each package dist dir to exactly the app folders whose closure includes it', async () => {
    const root = temp.register(
      makeMonorepo([
        { name: 'appX', packageName: 'appX-api' },
        { name: 'appY', packageName: 'appY-api' },
      ]),
    )
    const pkgADist = addPackage(root, 'pkgA', 'pkgA')
    const pkgCDist = addPackage(root, 'pkgC', 'pkgC')

    const dryRunner = fakeDryRunner({
      'appX-api': ['appX-api', 'pkgA', 'pkgC'],
      'appY-api': ['appY-api', 'pkgC'],
    })

    const { dependentsByPackageDir } = await buildClosureMap(
      root,
      [
        { name: 'appX', packageName: 'appX-api' },
        { name: 'appY', packageName: 'appY-api' },
      ],
      dryRunner,
    )

    expect(dependentsByPackageDir.get(pkgADist)).toEqual(new Set(['appX']))
    expect(dependentsByPackageDir.get(pkgCDist)).toEqual(new Set(['appX', 'appY']))
  })

  it('bridges a scoped package whose dir differs from its package.json name', async () => {
    const root = temp.register(makeMonorepo([{ name: 'appX', packageName: 'appX-api' }]))
    const fooDist = addPackage(root, 'foo', '@wl/foo')

    const { dependentsByPackageDir, packageNameByDir } = await buildClosureMap(
      root,
      [{ name: 'appX', packageName: 'appX-api' }],
      fakeDryRunner({ 'appX-api': ['appX-api', '@wl/foo'] }),
    )

    expect(packageNameByDir.get(fooDist)).toBe('@wl/foo')
    expect(dependentsByPackageDir.get(fooDist)).toEqual(new Set(['appX']))
  })

  it('omits a package no launched app depends on (kept out of the dependents map)', async () => {
    const root = temp.register(makeMonorepo([{ name: 'appX', packageName: 'appX-api' }]))
    const uiOnlyDist = addPackage(root, 'ui-only', 'ui-only')

    const { dependentsByPackageDir } = await buildClosureMap(
      root,
      [{ name: 'appX', packageName: 'appX-api' }],
      fakeDryRunner({ 'appX-api': ['appX-api'] }),
    )

    expect(dependentsByPackageDir.has(uiOnlyDist)).toBe(false)
  })

  it('propagates a DryRunner rejection (Promise.all) so the caller can apply its restart-all fail-safe', async () => {
    const root = temp.register(
      makeMonorepo([
        { name: 'appX', packageName: 'appX-api' },
        { name: 'appY', packageName: 'appY-api' },
      ]),
    )

    addPackage(root, 'pkgA', 'pkgA')

    const flakyDryRunner: DryRunner = (packageName: string): Promise<string[]> => {
      return packageName === 'appY-api'
        ? Promise.reject(new Error('turbo --dry failed'))
        : Promise.resolve(['appX-api', 'pkgA'])
    }

    await expect(
      buildClosureMap(
        root,
        [
          { name: 'appX', packageName: 'appX-api' },
          { name: 'appY', packageName: 'appY-api' },
        ],
        flakyDryRunner,
      ),
    ).rejects.toThrow(/turbo --dry failed/)
  })
})

describe('selectPackageRestartTargets — scope a package change to its dependents', () => {
  const apps = [
    { name: 'appX', watchDeps: true },
    { name: 'appY', watchDeps: true },
  ]
  const map: ClosureMap = {
    dependentsByPackageDir: new Map([
      ['/repo/packages/pkgA/dist', new Set(['appX'])],
      ['/repo/packages/pkgC/dist', new Set(['appX', 'appY'])],
    ]),
    packageNameByDir: new Map(),
  }

  it('restarts only the dependent app, not an unrelated one', () => {
    expect(selectPackageRestartTargets(apps, map, '/repo/packages/pkgA/dist')).toEqual([
      { name: 'appX', watchDeps: true },
    ])
  })

  it('restarts every dependent when a shared package changes', () => {
    expect(selectPackageRestartTargets(apps, map, '/repo/packages/pkgC/dist')).toEqual(apps)
  })

  it('returns an empty set (restart nothing) for a package no participating backend depends on', () => {
    expect(selectPackageRestartTargets(apps, map, '/repo/packages/ui-only/dist')).toEqual([])
  })

  it('excludes an opted-out backend (watchDeps:false) even when it is a dependent', () => {
    const optedOut = [
      { name: 'appX', watchDeps: false },
      { name: 'appY', watchDeps: true },
    ]

    expect(selectPackageRestartTargets(optedOut, map, '/repo/packages/pkgC/dist')).toEqual([
      { name: 'appY', watchDeps: true },
    ])
  })

  it('returns null (fail-safe: restart all) when the closure map is unavailable or the change has no package identity', () => {
    expect(selectPackageRestartTargets(apps, null, '/repo/packages/pkgA/dist')).toBeNull()
    expect(selectPackageRestartTargets(apps, map, undefined)).toBeNull()
  })
})
