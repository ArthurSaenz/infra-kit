import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { PACKAGE_TYPES, detectPackageType } from '../package-type'
import type { DetectPackageTypeArgs, PackageType, PackageTypeManifest } from '../package-type'

const REPO_ROOT = path.join(path.sep, 'repo')

const detect = (relDir: string, pkgJson: PackageTypeManifest = {}, declaredType?: PackageType): PackageType => {
  const args: DetectPackageTypeArgs = {
    packageDir: path.join(REPO_ROOT, ...relDir.split('/')),
    repoRoot: REPO_ROOT,
    pkgJson,
  }

  return detectPackageType(declaredType ? { ...args, declaredType } : args)
}

describe('detectPackageType — precedence', () => {
  it('an explicit declared type beats the directory convention', () => {
    expect(detect('apps/client/ui', {}, 'backend')).toBe('backend')
  })

  it('an explicit declared type beats the dependency signals', () => {
    expect(detect('packages/thing', { dependencies: { '@playwright/test': '^1.50.0' } }, 'lib')).toBe('lib')
  })

  it('the directory convention beats the dependency signals', () => {
    expect(detect('apps/client/ui', { dependencies: { '@playwright/test': '^1.50.0' } })).toBe('frontend')
  })
})

describe('detectPackageType — directory convention', () => {
  const rows: ReadonlyArray<[string, PackageType]> = [
    ['apps/client/ui', 'frontend'],
    ['apps/client/api', 'backend'],
    ['apps/client/tests', 'e2e'],
    ['apps/backoffice/ui', 'frontend'],
    ['packages/mobile-app', 'mobile'],
    ['apps/client/mobile-app', 'mobile'],
  ]

  it.each(rows)('%s → %s', (relDir, expected) => {
    expect(detect(relDir)).toBe(expected)
  })

  it('does not match a ui directory nested deeper than apps/<app>/ui', () => {
    expect(detect('apps/client/ui/src/widgets')).toBe('lib')
  })

  it('does not match a ui directory outside apps/', () => {
    expect(detect('packages/ui')).toBe('lib')
  })
})

describe('detectPackageType — dependency signals', () => {
  const rows: ReadonlyArray<[string, PackageTypeManifest, PackageType]> = [
    ['@playwright/test', { devDependencies: { '@playwright/test': '^1.50.0' } }, 'e2e'],
    ['@capacitor/core', { dependencies: { '@capacitor/core': '^7.0.0' } }, 'mobile'],
    ['@capacitor/cli', { devDependencies: { '@capacitor/cli': '^7.0.0' } }, 'mobile'],
    ['serverless', { devDependencies: { serverless: '^4.0.0' } }, 'backend'],
    // A lambda dependency alone never means backend: consumer backends are caught by the
    // `apps/<app>/api` directory rule, and the only packages these deps would catch are libraries
    // (`packages/lib-core` in both consumers, the infra-kit CLI itself).
    ['aws-lambda alone', { dependencies: { 'aws-lambda': '^1.0.7' } }, 'lib'],
    ['@types/aws-lambda alone', { devDependencies: { '@types/aws-lambda': '^8.10.0' } }, 'lib'],
    [
      'vite + react + a dev script',
      { dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^7.0.0' }, scripts: { dev: 'vite' } },
      'frontend',
    ],
    [
      'vite + react through peerDependencies',
      { peerDependencies: { react: '^19.0.0' }, devDependencies: { vite: '^7.0.0' }, scripts: { dev: 'vite' } },
      'frontend',
    ],
  ]

  it.each(rows)('%s → %s', (_label, pkgJson, expected) => {
    expect(detect('packages/thing', pkgJson)).toBe(expected)
  })

  it('react without vite is a library, not a frontend', () => {
    expect(detect('packages/ui-kit', { dependencies: { react: '^19.0.0' }, scripts: { dev: 'tsc --watch' } })).toBe(
      'lib',
    )
  })

  it('vite plus react without a dev script is a library, not a frontend', () => {
    expect(
      detect('packages/ui-kit', {
        dependencies: { react: '^19.0.0', vite: '^7.0.0' },
        scripts: { build: 'vite build' },
      }),
    ).toBe('lib')
  })
})

describe('detectPackageType — fallback', () => {
  it('an empty package.json in an unremarkable directory is a lib', () => {
    expect(detect('packages/lib-a')).toBe('lib')
  })

  it('the repo root itself falls back to lib rather than throwing', () => {
    expect(detectPackageType({ packageDir: REPO_ROOT, repoRoot: REPO_ROOT, pkgJson: {} })).toBe('lib')
  })

  it('every detected type is a member of PACKAGE_TYPES', () => {
    expect(PACKAGE_TYPES).toContain(detect('apps/client/ui'))
    expect([...PACKAGE_TYPES].sort()).toEqual(['backend', 'e2e', 'frontend', 'lib', 'mobile'])
  })
})
