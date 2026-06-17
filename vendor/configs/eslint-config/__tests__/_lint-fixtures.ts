import { ESLint } from 'eslint'
import type { Linter } from 'eslint'
import path from 'node:path'
import { expect } from 'vitest'

import config from '../index.js'

// Shared lint-and-index harness for the test suites. The two suites (no-restricted-imports
// and boundaries) ran byte-identical copies of this machinery; that duplication is what let
// their fixture vocabulary and assertion idioms drift apart. Owning it here makes the two
// suites symmetric by construction.
//
// cwd = package root. This file MUST live in __tests__/ (sibling of the test files) so
// `import.meta.dirname` resolves to <pkg>/__tests__ and `..` to the package root — the
// `fixtures` argument is package-root-relative and is resolved against this cwd. Moving this
// file to another directory silently shifts cwd and every messagesFor() throws.
const cwd = path.resolve(import.meta.dirname, '..')

interface LintIndexOptions {
  /** Fixture glob root, relative to the package root, e.g. `__tests__/fixtures/src`. */
  fixtures: string
  /** Which lint messages to keep per file (the rule(s) this suite cares about). */
  ruleFilter: (ruleId: string | null) => boolean
  /** The exact ruleId expectFlagged asserts. Must satisfy ruleFilter, else it sees length 0. */
  flagRuleId: string
}

/**
 * Lint the fixture tree once and index the matching messages by fixture path (posix-relative
 * to the fixtures root) for per-case assertions. `populate` is run via `beforeAll` in the
 * test file's own scope (vitest awaits it before any `it` body reads `byFile`).
 */
export const makeLintIndex = ({ fixtures, ruleFilter, flagRuleId }: LintIndexOptions) => {
  let byFile: Map<string, Linter.LintMessage[]>

  const populate = async () => {
    const eslint = new ESLint({
      cwd,
      overrideConfigFile: true, // ignore any ambient eslint.config.* — test the package's own config
      overrideConfig: await config(),
    })

    const results = await eslint.lintFiles([`${fixtures}/**/*.ts`])
    const fixturesRoot = path.resolve(cwd, fixtures)

    byFile = new Map(
      results.map((r) => {
        const rel = path.relative(fixturesRoot, r.filePath).split(path.sep).join('/')

        return [rel, r.messages.filter((m) => ruleFilter(m.ruleId ?? null))]
      }),
    )
  }

  const messagesFor = (relPath: string) => {
    const messages = byFile.get(relPath)

    if (!messages) {
      throw new Error(`Fixture "${relPath}" was not linted. Linted: ${[...byFile.keys()].join(', ')}`)
    }

    return messages
  }

  // Assert exactly one `flagRuleId` message whose text contains `messageSubstring`. The
  // substring is REQUIRED and is the discriminator proving the SPECIFIC rule fired (not merely
  // "a warning") — it is the single place to update if an upstream dependency bump changes the
  // plugin/core message copy.
  const expectFlagged = (relPath: string, messageSubstring: string) => {
    const messages = messagesFor(relPath)

    expect(messages).toHaveLength(1)
    expect(messages[0]?.ruleId).toBe(flagRuleId)
    expect(messages[0]?.message).toContain(messageSubstring)
  }

  return { populate, messagesFor, expectFlagged }
}
