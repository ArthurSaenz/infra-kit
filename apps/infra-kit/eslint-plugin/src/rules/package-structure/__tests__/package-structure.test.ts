import { PACKAGE_TYPES } from '@slip-stream-kit/config/package-type'
import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import type { Options, PackageType } from '../package-structure'
import { DEFAULT_ENTRIES, PACKAGE_TYPE_VALUES, packageStructure, resolveEntry } from '../package-structure'

const RULE_ID = '@wl/package-structure'
const SOURCE = 'export const a = 1\n'

describe('package type values', () => {
  // The rule declares its own list so the public .d.ts stays free of the config package; nothing
  // at compile time ties that list to PACKAGE_TYPES, so this runtime check is the whole binding.
  it('lists exactly the package types the config package knows', () => {
    expect([...PACKAGE_TYPE_VALUES]).toEqual([...PACKAGE_TYPES])
  })
})

describe('resolveEntry', () => {
  it('falls back to the built-in entry when the type key is absent', () => {
    expect(resolveEntry('frontend', {})).toBe(DEFAULT_ENTRIES.frontend)
    expect(resolveEntry('backend', { ignore: ['**/x/**'] })).toBe(DEFAULT_ENTRIES.backend)
  })

  it('replaces both layers and skill when the type key is present', () => {
    const entry = resolveEntry('frontend', { frontend: { layers: ['x'] } })

    expect(entry).toEqual({ layers: ['x'] })
    expect(entry?.skill).toBeUndefined()
  })

  it('has no entry for lib and mobile by default', () => {
    expect(resolveEntry('lib', {})).toBeUndefined()
    expect(resolveEntry('mobile', {})).toBeUndefined()
  })

  it('returns a consumer-added mobile entry without a skill', () => {
    expect(resolveEntry('mobile', { mobile: { layers: ['app', 'lib'] } })).toEqual({ layers: ['app', 'lib'] })
  })
})

// Message data needs a real package on disk: the type comes from a declared literal in
// `infra-kit.config.ts`, which the rule reads as text — there is no option that forces a type.
describe('message data', () => {
  let root: string
  let linter: Linter

  const packageDirOf = (type: PackageType): string => {
    return path.join(root, 'packages', type)
  }

  // `relDir` is the path below `src/`, so `'features/user/hooks'` exercises the segment level.
  const lint = (type: PackageType, relDir: string, options?: Options): string[] => {
    const filename = path.join(packageDirOf(type), 'src', relDir, 'a.ts')
    const ruleConfig: Linter.RuleEntry = options ? ['error', options] : 'error'
    const config: Linter.Config = {
      files: ['**/*.{ts,tsx,js,jsx}'],
      plugins: { '@wl': { rules: { 'package-structure': packageStructure } } },
      languageOptions: { parser: tsParser },
      rules: { [RULE_ID]: ruleConfig },
    }

    return linter.verify(SOURCE, config, { filename }).map((message) => {
      return message.message
    })
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'package-structure-messages-'))
    linter = new Linter({ cwd: root })

    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
    writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')

    for (const type of PACKAGE_TYPE_VALUES) {
      mkdirSync(packageDirOf(type), { recursive: true })
      writeFileSync(path.join(packageDirOf(type), 'package.json'), `{ "name": "${type}" }\n`)
      writeFileSync(path.join(packageDirOf(type), 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
    }
  })

  afterAll(() => {
    resetPackageRootCache()
    resetPackageTypeCache()
    rmSync(root, { recursive: true, force: true })
  })

  it('points a frontend package at the fe-architect skill', () => {
    const [message] = lint('frontend', 'core')

    expect(message).toContain('/infra-kit:fe-architect')
    expect(message).toBe(
      '`core` is not an allowed `src/` layer for package type `frontend` (allowed: app, features, lib, components, pages, routes). See /infra-kit:fe-architect for the frontend layout.',
    )
  })

  it('points a backend package at the be-architect skill', () => {
    expect(lint('backend', 'core')[0]).toContain('/infra-kit:be-architect')
  })

  it('points an e2e package at the e2e-architect skill', () => {
    expect(lint('e2e', 'core')[0]).toContain('/infra-kit:e2e-architect')
  })

  it('renders the type without an article', () => {
    expect(lint('e2e', 'core')[0]).toContain('package type `e2e`')
  })

  it('uses the consumer skill instead of the built-in one', () => {
    const [message] = lint('frontend', 'core', { frontend: { layers: ['app'], skill: 'docs/layout.md' } })

    expect(message).toContain('See docs/layout.md for the frontend layout.')
    expect(message).not.toContain('fe-architect')
  })

  it('drops the See sentence for an empty skill', () => {
    const [message] = lint('frontend', 'core', { frontend: { layers: ['app'], skill: '' } })

    // The template is `(allowed: …).{{seeSkill}}`, so an empty skill leaves the closing `).`
    expect(message).toMatch(/\)\.$/)
    expect(message).not.toContain('See')
  })

  it('has no See sentence for a consumer-added entry without a skill', () => {
    const [message] = lint('mobile', 'core', { mobile: { layers: ['app', 'lib'] } })

    expect(message).toBe('`core` is not an allowed `src/` layer for package type `mobile` (allowed: app, lib).')
  })

  it('is clean for an allowed layer', () => {
    expect(lint('frontend', 'features')).toEqual([])
    expect(lint('backend', 'controllers')).toEqual([])
    expect(lint('e2e', 'fixtures')).toEqual([])
  })

  it('names the unit a forbidden segment sits in', () => {
    const [message] = lint('frontend', 'features/user/hooks')

    expect(message).toBe(
      '`hooks` is not an allowed segment of `features/user` for package type `frontend` (allowed: containers, components, services, __stories__, __tests__). See /infra-kit:fe-architect for the frontend layout.',
    )
    expect(lint('backend', 'services/orders/fixtures')[0]).toBe(
      '`fixtures` is not an allowed segment of `services/orders` for package type `backend` (allowed: __tests__). See /infra-kit:be-architect for the backend layout.',
    )
  })

  it('names the layer itself for a direct-segment key', () => {
    const options: Options = { backend: { layers: ['services'], segments: { services: ['__tests__'] } } }

    expect(lint('backend', 'services/fixtures', options)[0]).toBe(
      '`fixtures` is not an allowed segment of `services` for package type `backend` (allowed: __tests__).',
    )
    expect(lint('backend', 'services/__tests__', options)).toEqual([])
  })

  it('rejects a segments key that names a layer outside layers', () => {
    const options: Options = { frontend: { layers: ['app'], segments: { 'features/*': ['x'] } } }

    expect(() => {
      return lint('frontend', 'app/x', options)
    }).toThrow('`frontend.segments` key "features/*" names a layer that is not in `frontend.layers` (app)')
  })
})
