import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import type { Options } from '../package-structure'
import { packageStructure } from '../package-structure'

// This suite exercises the REAL node:fs (no mock) against a fixture monorepo generated at runtime in
// a temp dir — NOT committed under src/, which the plugin lints (`eslint ./src`) and typechecks. It
// guards the walk-up → text read → inference chain end to end; a faked fs would let a broken chain
// stay green.

const RULE_ID = '@wl/package-structure'
const SOURCE = 'export const a = 1\n'

// The fixture mirrors the consumers' layout so directory inference has something to infer from.
// Packages that a case mutates (a config written, rewritten or stat-counted) are dedicated to that
// case, so the mtime-keyed type cache of one case can never leak into another.
const PACKAGES: Record<string, { pkgJson?: object; config?: string }> = {
  'apps/client/ui': {},
  'apps/client/api': {},
  'apps/client/tests': {},
  'packages/lib-x': { pkgJson: { devDependencies: { '@playwright/test': '^1' } } },
  'packages/lib-y': {},
  'apps/other/mobile-app': {},
  'apps/declared/ui': { config: "export default { type: 'backend' }\n" },
  'apps/computed/ui': { config: 'export default { type: pickType() }\n' },
  'apps/rewrite/ui': { config: "export default { type: 'frontend' }\n" },
  'apps/stat/api': { config: "export default { type: 'backend' }\n" },
}

let root: string
// Rooted at the temp dir so flat config matches files under it (see the stories integration suite).
let linter: Linter

const lint = (relPath: string, options?: Options): Linter.LintMessage[] => {
  const ruleConfig: Linter.RuleEntry = options ? ['error', options] : 'error'
  const config: Linter.Config = {
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: { '@wl': { rules: { 'package-structure': packageStructure } } },
    languageOptions: { parser: tsParser },
    rules: { [RULE_ID]: ruleConfig },
  }

  return linter.verify(SOURCE, config, { filename: path.join(root, relPath) })
}

const messagesOf = (relPath: string, options?: Options): string[] => {
  return lint(relPath, options).map((message) => {
    return message.message
  })
}

const configPathOf = (packageRel: string): string => {
  return path.join(root, packageRel, 'infra-kit.config.ts')
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'package-structure-integration-'))
  linter = new Linter({ cwd: root })

  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*/*'\n  - 'packages/*'\n")
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')

  for (const [packageRel, { pkgJson, config }] of Object.entries(PACKAGES)) {
    const packageDir = path.join(root, packageRel)

    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageRel, ...pkgJson }))

    if (config !== undefined) {
      fs.writeFileSync(configPathOf(packageRel), config)
    }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  resetPackageRootCache()
  resetPackageTypeCache()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('package-structure (real fs)', () => {
  it('declared-beats-directory', () => {
    // `apps/<app>/ui` infers frontend, but the config declares backend: the backend list applies.
    expect(messagesOf('apps/declared/ui/src/features/a.ts')[0]).toContain('package type `backend`')
    expect(messagesOf('apps/declared/ui/src/controllers/a.ts')).toEqual([])
  })

  it('inferred-from-directory', () => {
    const [message] = messagesOf('apps/client/ui/src/core/a.ts')

    expect(message).toContain('package type `frontend`')
    expect(message).toContain('/infra-kit:fe-architect')
    expect(messagesOf('apps/client/ui/src/features/a.ts')).toEqual([])
    expect(messagesOf('apps/client/tests/src/core/a.ts')[0]).toContain('package type `e2e`')
  })

  it('inferred-from-deps', () => {
    const [message] = messagesOf('packages/lib-x/src/core/a.ts')

    expect(message).toContain('package type `e2e`')
    expect(message).toContain('/infra-kit:e2e-architect')
    expect(messagesOf('packages/lib-x/src/tests/a.ts')).toEqual([])
  })

  it('lib-silent', () => {
    expect(messagesOf('packages/lib-y/src/anything/a.ts')).toEqual([])
    expect(messagesOf('packages/lib-y/src/anything/a.ts', { lib: { layers: ['core'] } })).toEqual([
      '`anything` is not an allowed `src/` layer for package type `lib` (allowed: core).',
    ])
  })

  it('mobile-silent', () => {
    expect(messagesOf('apps/other/mobile-app/src/anything/a.ts')).toEqual([])
    expect(messagesOf('apps/other/mobile-app/src/anything/a.ts', { mobile: { layers: ['app'] } })).toEqual([
      '`anything` is not an allowed `src/` layer for package type `mobile` (allowed: app).',
    ])
  })

  it('dunder-dirs-are-ordinary-layers', () => {
    expect(messagesOf('apps/client/ui/src/__tests__/a.ts')[0]).toContain('`__tests__` is not an allowed `src/` layer')
    expect(messagesOf('apps/client/ui/src/__mocks__/core/a.ts')[0]).toContain('`__mocks__` is not an allowed')
  })

  it('unit-segments', () => {
    // `features/*`: every folder of `features/` is a unit; only the listed segments may sit in it.
    expect(messagesOf('apps/client/ui/src/features/user/containers/a.tsx')).toEqual([])
    expect(messagesOf('apps/client/ui/src/features/user/__stories__/a.stories.tsx')).toEqual([])
    expect(messagesOf('apps/client/ui/src/features/user/hooks/a.ts')[0]).toContain(
      '`hooks` is not an allowed segment of `features/user`',
    )
    // A unit's own files and anything deeper than its segments are not inspected.
    expect(messagesOf('apps/client/ui/src/features/user/index.ts')).toEqual([])
    expect(messagesOf('apps/client/ui/src/features/user/components/default/a.tsx')).toEqual([])
    // Backend services mirror features: `__tests__` inside each service, nothing else.
    expect(messagesOf('apps/client/api/src/services/orders/__tests__/a.test.ts')).toEqual([])
    expect(messagesOf('apps/client/api/src/services/orders/fixtures/a.json.ts')[0]).toContain(
      '`fixtures` is not an allowed segment of `services/orders`',
    )
    // A flat `services/__tests__/` is a unit with files only, so it is silent.
    expect(messagesOf('apps/client/api/src/services/__tests__/a.test.ts')).toEqual([])
  })

  it('layers-without-segments-are-not-inspected', () => {
    expect(messagesOf('apps/client/ui/src/lib/anything/at/all.ts')).toEqual([])
    expect(messagesOf('apps/client/api/src/controllers/anything/at/all.ts')).toEqual([])
  })

  it('root-file-silent', () => {
    expect(messagesOf('apps/client/ui/src/main.ts')).toEqual([])
  })

  it('dist-src-silent', () => {
    expect(messagesOf('apps/client/ui/dist/src/core/a.js')).toEqual([])
  })

  it('override-replaces', () => {
    const [message] = messagesOf('apps/client/ui/src/features/a.ts', { frontend: { layers: ['x'] } })

    expect(message).toBe('`features` is not an allowed `src/` layer for package type `frontend` (allowed: x).')
    expect(messagesOf('apps/client/ui/src/x/a.ts', { frontend: { layers: ['x'] } })).toEqual([])
  })

  it('non-literal-type-falls-back', () => {
    expect(messagesOf('apps/computed/ui/src/core/a.ts')[0]).toContain('package type `frontend`')
  })

  it('missing-config-falls-back', () => {
    const messages = lint('apps/client/api/src/core/a.ts')

    expect(
      messages.filter((message) => {
        return message.ruleId === null
      }),
    ).toEqual([])
    expect(messages[0]?.message).toContain('/infra-kit:be-architect')
    expect(messagesOf('apps/client/api/src/controllers/a.ts')).toEqual([])
  })

  it('config-rewrite-seen-on-next-lint', () => {
    const configPath = configPathOf('apps/rewrite/ui')

    expect(messagesOf('apps/rewrite/ui/src/controllers/a.ts')[0]).toContain('package type `frontend`')

    fs.writeFileSync(configPath, "export default { type: 'backend' }\n")

    // A rewrite inside the same millisecond as the first read would leave the mtime unchanged and
    // mask the edit, so the bump is explicit.
    const bumped = new Date(Date.now() + 10_000)

    fs.utimesSync(configPath, bumped, bumped)

    expect(messagesOf('apps/rewrite/ui/src/controllers/a.ts')).toEqual([])
    expect(messagesOf('apps/rewrite/ui/src/features/a.ts')[0]).toContain('package type `backend`')
  })

  it('one-stat-per-file', () => {
    const configPath = configPathOf('apps/stat/api')
    const statSync = vi.spyOn(fs, 'statSync')
    const readFileSync = vi.spyOn(fs, 'readFileSync')
    const files = ['apps/stat/api/src/core/a.ts', 'apps/stat/api/src/core/b.ts', 'apps/stat/api/src/services/c.ts']

    for (const file of files) {
      lint(file)
    }

    const callsOn = (calls: unknown[][]): number => {
      return calls.filter(([target]) => {
        return target === configPath
      }).length
    }

    expect(callsOn(statSync.mock.calls)).toBe(files.length)
    expect(callsOn(readFileSync.mock.calls)).toBe(1)
  })

  it('outside-package-silent', () => {
    // The fixture root's own package.json makes it the package; `scripts/` is not under its `src/`.
    expect(messagesOf('scripts/core/a.ts')).toEqual([])
  })
})
