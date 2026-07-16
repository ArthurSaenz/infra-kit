import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The Esc contract is ALL-OR-NONE, and this is what keeps it that way.
 *
 * Wiring only some `@inquirer` prompts is worse than wiring none: today's boundary is
 * learnable ("Esc works in the Ink screens, not in the inquirer prompts") and coincides
 * with a visible rendering difference. A half-wired codebase replaces that with an
 * invisible, arbitrary one — `dev-wizard-run`'s `select` and `release-create`'s `select`
 * are literally the same component. So a NEW call site that forgets `withEscape` must
 * fail loudly here rather than silently regressing the contract to N-of-N+1.
 *
 * This sweep proves WIRING, not co-import. It was a `toContain('withEscape')` string
 * check, which proved only that a module named the wrapper SOMEWHERE — and it green-lit
 * `worktrees-add.ts`, a file that wraps two prompts and then calls a third raw. That
 * miss stopped being cosmetic when `withEscape` took ownership of the stdin ref
 * (lib/prompts/stdin-ref.ts): an unwrapped prompt no longer merely loses Esc, it reads a
 * stdin that Ink unref'd on teardown, and the process dies mid-prompt with exit 13. The
 * escape hatch a raw prompt takes is invisible, so the check has to be structural.
 *
 * THE RULE — every CALL to an `@inquirer/*` PROMPT must sit lexically inside a
 * `withEscape(...)` callback. Which bindings are prompts depends on the package, and
 * `promptNames` below is the authority: the DEFAULT import of a per-prompt package
 * (`@inquirer/confirm`, `select`, `checkbox`, `password`), and the NAMED imports of the
 * `@inquirer/prompts` meta package. Two deliberate exclusions:
 * - Named imports of a PER-PROMPT package (`Separator` from `@inquirer/select`) are not
 *   prompts; they render list dividers. Named imports of the meta package ARE prompts,
 *   which is why the distinction is by package rather than by import form.
 * - Calls through an injectable seam (`prompts.select(…)` in dev-wizard-run) are property
 *   accesses, not identifier calls, so they are invisible here. That is correct: the
 *   wizard wraps the seam's DEFAULT implementation instead, and that wrapper is swept.
 *
 * KNOWN HOLE — `import * as p from '@inquirer/prompts'` binds a namespace, and `p.select(…)`
 * is a property access, so it would slip through. Nothing does it; the meta package is not
 * even a dependency. Left open rather than closed blind: catching it means matching property
 * accesses, which is the same shape as the seam exclusion above, and a rule that has to tell
 * those two apart is a rule that will eventually get it wrong. Named here so the next reader
 * finds it in the docstring rather than in production.
 */
const SRC = path.resolve(__dirname, '../../..')

const walk = (dir: string): string[] => {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full)

    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : []
  })
}

/**
 * Local names bound to an `@inquirer/*` prompt function.
 *
 * The per-prompt packages this tree depends on (`@inquirer/confirm`, `select`, `checkbox`,
 * `password`) export the prompt as their DEFAULT, so a default import is the prompt and a
 * named one is not: `import inquirerSelect, { Separator } from '@inquirer/select'`
 * contributes `inquirerSelect` and deliberately not `Separator`, which draws list dividers.
 *
 * The `@inquirer/prompts` META package is the exception — there the prompts ARE the named
 * exports. Nothing imports it today, but it is one `pnpm add` away, and under a
 * default-only rule this sweep would wave its call sites through in silence. Cheap to
 * pre-empt, so it is.
 */
const META_PACKAGE = '@inquirer/prompts'

const promptNames = (source: ts.SourceFile): Set<string> => {
  const names = new Set<string>()

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!statement.moduleSpecifier.text.startsWith('@inquirer/')) continue

    const defaultName = statement.importClause?.name

    if (defaultName) names.add(defaultName.text)

    const bindings = statement.importClause?.namedBindings

    if (statement.moduleSpecifier.text === META_PACKAGE && bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.add(element.name.text)
    }
  }

  return names
}

/** Is `node` lexically inside a `withEscape(...)` call? */
const insideWithEscape = (node: ts.Node): boolean => {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === 'withEscape'
    ) {
      return true
    }
  }

  return false
}

/** Every `promptName(...)` call in the file, tagged with whether it is wrapped. */
const promptCalls = (source: ts.SourceFile, names: Set<string>): { line: number; wrapped: boolean }[] => {
  const calls: { line: number; wrapped: boolean }[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
      calls.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        wrapped: insideWithEscape(node),
      })
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return calls
}

const sites = walk(SRC).flatMap((file) => {
  const text = readFileSync(file, 'utf8')

  // `setParentNodes: true` — `insideWithEscape` walks `node.parent` upwards.
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const names = promptNames(source)

  if (names.size === 0) return []

  return promptCalls(source, names).map((call) => {
    return { ...call, where: `${path.relative(SRC, file)}:${call.line}` }
  })
})

describe('every @inquirer call site routes through withEscape', () => {
  it('finds the call sites at all (guards against a vacuous pass)', () => {
    // If a refactor moved the prompts, the sweep below would pass by finding nothing.
    expect(sites.length).toBeGreaterThan(5)
  })

  it('has no prompt call outside a withEscape callback', () => {
    const unwrapped = sites
      .filter((site) => {
        return !site.wrapped
      })
      .map((site) => {
        return site.where
      })

    expect(unwrapped).toEqual([])
  })
})
