import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyDistChange,
  discoverApiApps,
  findMonorepoRoot,
  getAppDistDirs,
  getPackageDistDirs,
  getPackageName,
  normalizeAppInclude,
} from 'src/dev/discovery'

import { createTempTracker, makeMonorepo } from './fixtures'

/**
 * Filesystem discovery, driven by an explicit `root` argument — no chdir, no cast.
 * Each spec builds a hermetic monorepo fixture and passes its path straight in.
 */
const temp = createTempTracker()

afterEach(() => {
  temp.cleanup()
})

describe('discoverApiApps — app discovery', () => {
  it('discovers every apps/<app> that has an api/serverless.yml', () => {
    const root = temp.register(makeMonorepo([{ name: 'client' }, { name: 'backoffice' }]))

    const names = discoverApiApps(root)
      .map((a) => {
        return a.name
      })
      .sort()

    expect(names).toEqual(['backoffice', 'client'])
  })

  it('ignores app folders that have no serverless.yml', () => {
    const root = temp.register(makeMonorepo([{ name: 'client' }, { name: 'web', api: false }]))

    const names = discoverApiApps(root).map((a) => {
      return a.name
    })

    expect(names).toEqual(['client'])
  })

  it('reads packageName from package.json, falling back to the folder name', () => {
    const root = temp.register(
      makeMonorepo([{ name: 'client', packageName: 'sls-trvl-client' }, { name: 'backoffice' }]),
    )

    const byName = new Map(
      discoverApiApps(root).map((a) => {
        return [a.name, a.packageName]
      }),
    )

    expect(byName.get('client')).toBe('sls-trvl-client')
    expect(byName.get('backoffice')).toBe('backoffice')
  })
})

describe('findMonorepoRoot — walk up to pnpm-workspace.yaml', () => {
  it('returns the dir that holds pnpm-workspace.yaml when starting from a nested api dir', () => {
    const root = temp.register(makeMonorepo([{ name: 'client' }]))
    const startDir = path.join(root, 'apps', 'client', 'api')

    expect(findMonorepoRoot(startDir)).toBe(root)
  })
})

describe('getPackageName — package.json name with fallback', () => {
  it('returns the package.json name field when present', () => {
    const root = temp.register(makeMonorepo([{ name: 'client', packageName: 'sls-trvl-client' }]))
    const apiDir = path.join(root, 'apps', 'client', 'api')

    expect(getPackageName(apiDir, 'client')).toBe('sls-trvl-client')
  })

  it('falls back to the given app name when there is no package.json', () => {
    const root = temp.register(makeMonorepo([{ name: 'backoffice' }]))
    const apiDir = path.join(root, 'apps', 'backoffice', 'api')

    expect(getPackageName(apiDir, 'backoffice')).toBe('backoffice')
  })
})

describe('normalizeAppInclude — --app list normalization', () => {
  it('normalizes empty, whitespace-only, undefined, and null lists to null', () => {
    expect(normalizeAppInclude([])).toBeNull()
    expect(normalizeAppInclude([''])).toBeNull()
    expect(normalizeAppInclude(undefined)).toBeNull()
    expect(normalizeAppInclude(null)).toBeNull()
  })

  it('keeps a non-empty list and drops falsy entries', () => {
    expect(normalizeAppInclude(['client', ''])).toEqual(['client'])
  })
})

describe('classifyDistChange — route a compiled-output path to app vs package', () => {
  const appDistDirs = ['/repo/apps/client/api/dist']
  const packageDistDirs = ['/repo/packages/lib-core/dist']

  it('classifies an app-dist path as an app change and returns the matched app dist dir', () => {
    const change = classifyDistChange('/repo/apps/client/api/dist/controllers/x.js', appDistDirs, packageDistDirs)

    expect(change).toEqual({ kind: 'app', app: '/repo/apps/client/api/dist' })
  })

  it('classifies a package-dist path as a package change (a lib was rebuilt → restart all)', () => {
    const change = classifyDistChange('/repo/packages/lib-core/dist/index.js', appDistDirs, packageDistDirs)

    expect(change).toEqual({ kind: 'package' })
  })

  it('returns an app change with undefined dir when nothing matches', () => {
    const change = classifyDistChange('/repo/elsewhere/dist/x.js', appDistDirs, packageDistDirs)

    expect(change).toEqual({ kind: 'app', app: undefined })
  })
})

describe('getPackageDistDirs / getAppDistDirs — existing dist dirs only', () => {
  it('returns packages/<pkg>/dist dirs that exist and skips those without a dist', () => {
    const root = temp.register(makeMonorepo([{ name: 'client', withHandler: true }]))

    // makeMonorepo only scaffolds apps/*; add a packages/ tree with one built + one unbuilt pkg.
    fs.mkdirSync(path.join(root, 'packages', 'lib-core', 'dist'), { recursive: true })
    fs.mkdirSync(path.join(root, 'packages', 'lib-unbuilt', 'src'), { recursive: true })

    const distDirs = getPackageDistDirs(root)

    expect(distDirs).toContain(path.join(root, 'packages', 'lib-core', 'dist'))
    expect(distDirs).not.toContain(path.join(root, 'packages', 'lib-unbuilt', 'dist'))
  })

  it('returns <app.path>/dist dirs that exist (withHandler apps have one)', () => {
    const root = temp.register(makeMonorepo([{ name: 'client', withHandler: true }]))
    const apiDir = path.join(root, 'apps', 'client', 'api')

    const distDirs = getAppDistDirs([{ path: apiDir }])

    expect(distDirs).toEqual([path.join(apiDir, 'dist')])
  })
})
