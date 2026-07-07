import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyDistChange,
  discoverApiApps,
  discoverUiApps,
  findMonorepoRoot,
  getAppDistDirs,
  getPackageDistDirs,
  getPackageName,
  normalizeAppInclude,
  resolveSelfAppName,
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

describe('discoverUiApps — frontends with a `dev` script', () => {
  it('discovers apps/<app>/ui that declare a dev script, resolving the package name', () => {
    const root = temp.register(
      makeMonorepo([
        { name: 'backoffice', ui: { packageName: 'backoffice-ui' } },
        { name: 'client', ui: { packageName: 'website-ui' } },
      ]),
    )

    const uiApps = discoverUiApps(root)

    expect(uiApps).toEqual([
      { name: 'backoffice', packageName: 'backoffice-ui', path: path.join(root, 'apps', 'backoffice', 'ui') },
      { name: 'client', packageName: 'website-ui', path: path.join(root, 'apps', 'client', 'ui') },
    ])
  })

  it('ignores a ui folder that has no dev script', () => {
    const root = temp.register(makeMonorepo([{ name: 'seo', ui: { dev: false } }]))

    expect(discoverUiApps(root)).toEqual([])
  })

  it('returns [] when there is no apps/ dir (UIs are optional, unlike api discovery)', () => {
    const root = temp.register(makeMonorepo([]))

    fs.rmSync(path.join(root, 'apps'), { recursive: true, force: true })
    expect(discoverUiApps(root)).toEqual([])
  })
})

describe('resolveSelfAppName — infer the current app from cwd', () => {
  it('resolves the app name when cwd is apps/<app>/api', () => {
    const root = temp.register(makeMonorepo([{ name: 'config-handler' }]))
    const apiDir = path.join(root, 'apps', 'config-handler', 'api')

    expect(resolveSelfAppName(apiDir)).toBe('config-handler')
  })

  it('resolves the app name when cwd is apps/<app> itself', () => {
    const root = temp.register(makeMonorepo([{ name: 'config-handler' }]))
    const appDir = path.join(root, 'apps', 'config-handler')

    expect(resolveSelfAppName(appDir)).toBe('config-handler')
  })

  it('throws when cwd is the monorepo root (not inside apps/<app>)', () => {
    const root = temp.register(makeMonorepo([{ name: 'config-handler' }]))

    expect(() => {
      return resolveSelfAppName(root)
    }).toThrow(/not inside an apps\/<app> directory/)
  })

  it('throws when cwd is outside apps/ entirely', () => {
    const root = temp.register(makeMonorepo([{ name: 'config-handler' }]))
    const outsideDir = path.join(root, 'packages', 'lib-core')

    expect(() => {
      return resolveSelfAppName(outsideDir)
    }).toThrow(/not inside an apps\/<app> directory/)
  })
})
