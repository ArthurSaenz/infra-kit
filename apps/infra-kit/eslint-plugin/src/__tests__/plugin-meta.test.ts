import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import wl, { rules } from '../index'
import { resetPackageRootCache } from '../utils/package-root'
import { resetPackageTypeCache } from '../utils/package-type-reader'

// `plugin.meta.version` is hand-written and has already drifted from `package.json` once (it sat at
// 0.1.20 against a published 0.1.21), which silently mislabels every report ESLint attributes to the
// plugin. Read at runtime rather than imported: `composite: true` requires every file in the TS
// program to be inside `include`, and `package.json` is not.
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }

const recommended = wl.configs.recommended ?? []
const presetBlocks = Array.isArray(recommended) ? recommended : [recommended]

const presetRuleIds = presetBlocks.flatMap((block) => {
  return Object.keys(block.rules ?? {})
})

describe('plugin meta', () => {
  it('declares the same version as package.json', () => {
    expect(wl.meta?.version).toBe(pkg.version)
  })
})

// Every rule's `meta.docs.url` points at a readme anchor. A rule shipped without its section
// leaves that link dead, and nothing else notices — the readme is outside the package's prettier glob
// and no build step reads it.
const readme = readFileSync(new URL('../../readme.md', import.meta.url), 'utf8')

describe('rule docs anchors', () => {
  it.each(Object.entries(rules))('%s has a readme section matching its docs url anchor', (ruleId, rule) => {
    const url = rule.meta?.docs?.url ?? ''
    const anchor = url.slice(url.indexOf('#') + 1)

    expect(anchor).toBe(ruleId)
    expect(readme).toContain(`### \`${ruleId}\``)
  })
})

describe('max-jsdoc-lines registration', () => {
  it('is registered in the rule map', () => {
    expect(rules['max-jsdoc-lines']).toBeDefined()
  })

  // DELIBERATE OMISSION, asserted so it cannot be "fixed" by accident. The preset registers its
  // rules under the components gate, which carries no `ignores` — enabling `max-jsdoc-lines` there
  // would give one policy two switches and re-expose test/story/`.d.ts` files the config layer's
  // `GLOB_TS_DOC_EXCLUDE` deliberately excludes. It ships behind the `o.jsdoc` gate in
  // `configs/docs.ts` instead, which owns its severity outright.
  it('is NOT enabled by the recommended preset', () => {
    expect(presetRuleIds).not.toContain('@wl/max-jsdoc-lines')
  })
})

describe('max-jsdoc-summary-lines registration', () => {
  it('is registered in the rule map', () => {
    expect(rules['max-jsdoc-summary-lines']).toBeDefined()
  })

  // Same DELIBERATE OMISSION as its sibling, and for the same reason: the preset's rules sit under
  // the components gate, which carries no `ignores`, so enabling a JSDoc rule there would re-expose
  // the test/story/`.d.ts` files the config layer's `GLOB_TS_DOC_EXCLUDE` excludes. It ships behind
  // the consuming repo's own config instead. Asserted as a pair with `max-jsdoc-lines` so adding
  // one to the preset without the other cannot happen quietly.
  it('is NOT enabled by the recommended preset', () => {
    expect(presetRuleIds).not.toContain('@wl/max-jsdoc-summary-lines')
  })
})

describe('package-structure registration', () => {
  it('is registered in the rule map', () => {
    expect(rules['package-structure']).toBeDefined()
  })

  it('is enabled by the recommended preset', () => {
    expect(presetRuleIds).toContain('@wl/package-structure')
  })
})

// The REAL preset against a real fixture: the rule lives in its own `**/*.{ts,tsx,js,jsx}` block
// because the components gate is `**/*.tsx` only — a regression that folded it into that block
// would still pass a unit test on the rule and only show up here, on a `.ts` file.
describe('package-structure preset layering', () => {
  let root: string
  let linter: Linter

  const lintWithPreset = (relPath: string): string[] => {
    const config: Linter.Config[] = [
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
      },
      ...presetBlocks,
    ]

    return linter
      .verify('export const a = 1\n', config, { filename: path.join(root, relPath) })
      .filter((message) => {
        return message.ruleId === '@wl/package-structure'
      })
      .map((message) => {
        return message.message
      })
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'plugin-meta-preset-'))
    linter = new Linter({ cwd: root })

    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*/*'\n")
    writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')
    mkdirSync(path.join(root, 'apps/client/ui'), { recursive: true })
    writeFileSync(path.join(root, 'apps/client/ui/package.json'), '{ "name": "ui" }\n')
  })

  afterAll(() => {
    resetPackageRootCache()
    resetPackageTypeCache()
    rmSync(root, { recursive: true, force: true })
  })

  it('fires for a .ts file under a disallowed layer', () => {
    expect(lintWithPreset('apps/client/ui/src/core/a.ts')).toHaveLength(1)
  })

  it('stays silent for a .tsx file under an allowed layer', () => {
    expect(lintWithPreset('apps/client/ui/src/features/a.tsx')).toEqual([])
  })

  it('fires for a .tsx file under a disallowed layer, so the silence above is the layer, not the extension', () => {
    expect(lintWithPreset('apps/client/ui/src/core/a.tsx')).toHaveLength(1)
  })
})
