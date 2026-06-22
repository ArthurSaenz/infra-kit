import { ESLint } from 'eslint'
import type { Linter } from 'eslint'
import path from 'node:path'
import { expect } from 'vitest'

import config from '../index.js'

// Declarative lint harness for the glob/path-driven suites. Each case carries inline `code` and a
// virtual `fileName`; `lintCase` lints the string under that virtual path against the REAL exported
// config (`config()`), so the wired file-glob behavior is what's exercised — not a single rule via
// RuleTester. This replaces the on-disk `_lint-fixtures.ts` index: the example now lives next to its
// expectation in the test file.
//
// cwd = package root. This file MUST stay in __tests__/ so `import.meta.dirname` resolves to
// <pkg>/__tests__ and `..` to the package root — virtual `fileName`s are resolved against that root.
const cwd = path.resolve(import.meta.dirname, '..')

// Lazy singleton: config() is resolved once and the instance reused across all glob/path cases.
// ESLint is stateless per lint call, so one instance is correct and faster. (The boundaries suite
// builds its OWN instance bound to a temp-dir cwd — see _boundaries-tree.ts.)
let eslintPromise: Promise<ESLint> | undefined
const getEslint = async () => {
  eslintPromise ??= (async () => new ESLint({ cwd, overrideConfigFile: true, overrideConfig: await config() }))()

  return eslintPromise
}

export interface LintCase {
  /** Source under test, usually a `code\`...\`` template. */
  source: string
  /** Virtual path that drives glob/path-based config, e.g. 'src/features/beta/x.ts'. */
  fileName: string
}

// Tagged template for inline source: strips the leading newline and the common leading indentation
// so a case can be written as readable, naturally-indented code while what actually gets linted has
// no stray indentation (which would otherwise change whitespace-sensitive rules). Usage:
//   const src = code`
//     import x from 'x'
//
//     export const a = x
//   `
export const code = (strings: TemplateStringsArray, ...values: unknown[]): string => {
  const raw = strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), '')
  const body = raw.replace(/^\n/, '').replace(/\n[ \t]*$/, '')
  const lines = body.split('\n')
  const indents = lines.filter((line) => line.trim() !== '').map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0)
  const common = indents.length > 0 ? Math.min(...indents) : 0

  return lines.map((line) => line.slice(common)).join('\n')
}

/**
 * Lint inline `code` under a virtual `fileName` against the real exported config.
 *
 * Silent-false-pass guard (structural successor to the old `messagesFor()` throw): an ignored or
 * out-of-base path makes ESLint return a single `ruleId: null` "File ignored…" message, which any
 * rule filter would discard to length 0 — a vacuous "clean". Both checks below turn that into a loud
 * failure so a mistyped `fileName` can never silently pass.
 */
export const lintCase = async ({ source, fileName }: LintCase): Promise<Linter.LintMessage[]> => {
  const eslint = await getEslint()
  const filePath = path.resolve(cwd, fileName)

  // (a) fail fast if the virtual path is ignored or outside the lint base.
  expect(await eslint.isPathIgnored(filePath)).toBe(false)

  const [result] = await eslint.lintText(source, { filePath })
  const messages = result?.messages ?? []

  // (b) the lone ruleId=null "File ignored…" message — throw loudly instead of filtering to 0.
  if (messages.length === 1 && messages[0]?.ruleId === null) {
    throw new Error(`lintCase: "${fileName}" was not linted (ruleId=null: ${messages[0]?.message})`)
  }

  return messages
}

// Keep only messages for a given ruleId (or ruleId prefix, e.g. 'boundaries/'). Inline snippets that
// aren't perfectly antfu/prettier-clean carry unrelated messages (e.g. import/newline-after-import),
// so every per-case assertion filters to the rule under test before asserting.
export const only = (messages: Linter.LintMessage[], ruleIdOrPrefix: string) =>
  messages.filter(
    (m) => (m.ruleId ?? '') === ruleIdOrPrefix || (m.ruleId ?? '').startsWith(`${ruleIdOrPrefix.replace(/\/$/, '')}/`),
  )

// Assert exactly one message of `ruleId` whose text contains `substr` — the discriminator proving
// the SPECIFIC rule fired (not merely "a warning").
export const expectFlagged = (messages: Linter.LintMessage[], ruleId: string, substr: string) => {
  const hits = only(messages, ruleId)

  expect(hits).toHaveLength(1)
  expect(hits[0]?.message).toContain(substr)
}

// Symmetric to expectFlagged: assert zero messages for `ruleId`.
export const expectClean = (messages: Linter.LintMessage[], ruleId: string) => {
  expect(only(messages, ruleId)).toHaveLength(0)
}

// Looser variant: at least one message for `ruleId`. Used where coupling to the exact messageId set
// would be brittle (e.g. the component-file-order control case).
export const expectAtLeastOne = (messages: Linter.LintMessage[], ruleId: string) => {
  expect(only(messages, ruleId).length).toBeGreaterThanOrEqual(1)
}
