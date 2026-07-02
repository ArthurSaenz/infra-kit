import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyChange,
  discoverApiApps,
  findMonorepoRoot,
  getPackageName,
  normalizeAppFilters,
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

describe('normalizeAppFilters — include/exclude normalization', () => {
  it('normalizes empty and whitespace-only lists to null', () => {
    expect(normalizeAppFilters({ include: [], exclude: [''] })).toEqual({ include: null, exclude: null })
  })

  it('keeps non-empty lists and drops falsy entries', () => {
    expect(normalizeAppFilters({ include: ['client', ''], exclude: ['backoffice'] })).toEqual({
      include: ['client'],
      exclude: ['backoffice'],
    })
  })
})

describe('classifyChange — route a changed file to app vs package', () => {
  const appSrcDirs = ['/repo/apps/client/api/src']
  const packageSrcDirs = ['/repo/packages/core/src']

  it('classifies an app-src path as an app change and returns the matched app dir', () => {
    const change = classifyChange('/repo/apps/client/api/src/handler.ts', appSrcDirs, packageSrcDirs)

    expect(change).toEqual({ kind: 'app', app: '/repo/apps/client/api/src' })
  })

  it('classifies a package-src path as a package change', () => {
    const change = classifyChange('/repo/packages/core/src/index.ts', appSrcDirs, packageSrcDirs)

    expect(change).toEqual({ kind: 'package' })
  })

  it('gives package matches precedence when a path could match both', () => {
    // Same dir listed as both an app and a package src — package is checked first.
    const shared = ['/repo/shared/src']
    const change = classifyChange('/repo/shared/src/x.ts', shared, shared)

    expect(change.kind).toBe('package')
  })
})
