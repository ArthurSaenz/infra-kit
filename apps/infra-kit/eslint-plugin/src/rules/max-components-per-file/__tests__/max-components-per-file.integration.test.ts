import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

import wl from '../../../index'

// Guards the flat-config LAYERING the SHIPPED `configs.recommended` preset relies on. ESLint flat
// config REPLACES rule options across matching blocks (it does not merge them), so the tighter
// `*-component.tsx` ceiling must re-declare `ignore` or pages/routes dumb-components silently lose
// their exemption. This suite resolves the REAL preset (imported from src/index.ts, not a copy) and
// asserts the effective per-path behaviour — so deleting `ignore` from the `*-component.tsx` block in
// src/index.ts turns this suite red. The RuleTester (which passes `options` directly) cannot catch a
// layering bug, and a hand-copied mirror would not catch a source regression.

const RULE_ID = '@wl/max-components-per-file'

// `?? []` satisfies `noUncheckedIndexedAccess` (Record access is `T | undefined`); the preset always
// exists at runtime.
const recommended = wl.configs.recommended ?? []
const presetBlocks: Linter.Config[] = Array.isArray(recommended) ? recommended : [recommended]

// The recommended preset deliberately omits a parser (consumers supply one). Append a parser-only
// block so the Linter can parse TSX; languageOptions MERGE across flat-config blocks.
const config: Linter.Config[] = [
  ...presetBlocks,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },
]

const componentsSource = (...names: string[]): string => {
  return names
    .map((name) => {
      return `export const ${name} = () => <div />`
    })
    .join('\n')
}

const FIVE = componentsSource('A', 'B', 'C', 'D', 'E')
const FOUR = componentsSource('A', 'B', 'C', 'D')
const TWO = componentsSource('A', 'B')

const linter = new Linter({ configType: 'flat' })

// Isolate this rule from the other recommended rules (props/order/stories) that also lint the source.
const ruleMessages = (code: string, filename: string): Linter.LintMessage[] => {
  return linter.verify(code, config, { filename }).filter((message) => {
    return message.ruleId === RULE_ID
  })
}

describe('max-components-per-file (shipped preset layering)', () => {
  it('applies the global ceiling of 4 to a plain .tsx file', () => {
    const messages = ruleMessages(FIVE, 'src/widgets/widget.tsx')

    expect(messages).toHaveLength(1)
    expect(messages[0]?.messageId).toBe('tooManyComponents')
  })

  it('does not flag a plain .tsx file at exactly 4 components', () => {
    expect(ruleMessages(FOUR, 'src/widgets/widget.tsx')).toHaveLength(0)
  })

  it('tightens the ceiling to 1 for *-component.tsx files', () => {
    const messages = ruleMessages(TWO, 'src/components/foo/foo-component.tsx')

    expect(messages).toHaveLength(1)
    expect(messages[0]?.messageId).toBe('tooManyComponents')
  })

  // Fails if the `ignore` is dropped from the `*-component.tsx` block in src/index.ts (the exact
  // option-replacement regression the layering is designed to prevent).
  it('keeps the pages/routes exemption for *-component.tsx (layering preserves ignore)', () => {
    expect(ruleMessages(FIVE, 'src/pages/dashboard-component.tsx')).toHaveLength(0)
  })

  it('keeps the pages/routes exemption for plain .tsx route files', () => {
    expect(ruleMessages(FIVE, 'src/routes/app.tsx')).toHaveLength(0)
  })
})
