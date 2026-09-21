import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

import { commandCatalog } from 'src/lib/command-catalog'
import type { CatalogMcpTool } from 'src/lib/command-catalog/command-catalog'

/**
 * @fileoverview
 * Shared machinery for the two guards that need to know WHICH `withEscape` call sites an agent
 * can actually reach: the headless-policy sweep in `every-inquirer-site-is-escapable.test.ts` and
 * the G6/G8 claim checks in `headless-policy-guards.test.ts`.
 *
 * Not a `.test.ts`, so vitest's default include glob does not collect it, and it sits under
 * `__tests__/` so both sweeps' walkers skip it — this file can never become its own subject.
 *
 * THE SURFACE IS BASH, NOT A TOOL LIST. An agent drives this CLI as `Bash(infra-kit …)`, so every
 * command is reachable whether or not it ever carried a `defineMcpTool`; the catalog's `mcpExposed`
 * is historical ("was listed on the retired server") and filtering on it left `env-token-set` and
 * `env-token-remove` — both `mutating: true, mcpExposed: false` — outside every guard here. Roots are
 * therefore every file declaring a `defineMcpTool({ name })` PLUS every `src/commands/<cmd>/<cmd>.ts`
 * that declares none. Only `entry/cli.ts`'s palette stays out: it is not a command, and a human typed
 * the bare `infra-kit` that opens it.
 *
 * REACHABILITY IS MODULE-LEVEL, and deliberately so: the closure follows value imports, re-exports
 * and dynamic `import(…)`. It is an OVER-approximation — a barrel drags in siblings the command never
 * calls, so `lib/release-deploy/source-picker.ts` counts as reachable through
 * `lib/release-deploy/index.ts` even though only the merged `release-deploy` command calls it, and
 * `dev/dev-wizard-run.ts` counts although the wizard runs only on a bare TTY `dev`. Over-approximating
 * is the safe direction: it can demand an annotation nobody needed, never miss one that was.
 *
 * KNOWN HOLES, named rather than closed blind (same convention as the sweep next door):
 * - Type-only imports are skipped. They erase, so they open no runtime path — but a value import
 *   used only as a type still counts, and will over-approximate.
 * - A specifier built at runtime (`import(someVariable)`) is invisible. **Four sites do this** (AST
 *   census, not a grep): `config-loader.ts:53`, `vendor-config.ts:129`, `migrate-config.ts:244`,
 *   `serverless-local-run.ts:311`. None can conceal a `withEscape` site, for TWO independent reasons,
 *   and the second is the durable one: every such specifier is an absolute `file://` URL from
 *   `pathToFileURL`, and `resolveSpec` below only ever resolves relative or `src/…` specifiers — so a
 *   `file://` URL is unresolvable BY CONSTRUCTION, wherever it points. Separately, all four happen to
 *   address files outside this tree (a user's `infra-kit.config.ts`, `~/.infra-kit/vendor.config.ts`,
 *   a repo root, and a consumer's `.js` controller that `walkSources` does not even collect).
 *   Rely on the first reason; the second is contingent and could change without notice.
 * - Reachability stops at the module, not the function. A module reachable for one export is
 *   reachable for all of them.
 */
export const SRC = path.resolve(__dirname, '../../..')

/** Every `.ts`/`.tsx` under `src`, minus `__tests__` — the same walk the sibling sweep uses. */
export const walkSources = (dir: string): string[] => {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walkSources(full)

    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : []
  })
}

const files = walkSources(SRC)
const parsed = new Map<string, ts.SourceFile>()

/**
 * `.ts` MUST parse as TS, not TSX: under TSX a generic arrow like `async <T>(…) =>` reads as an
 * unclosed JSX tag and the parser fails OPEN — the rest of the file becomes garbage and every
 * `defineMcpTool`/`withEscape` below it disappears. `gh-release-deliver.ts:44` is exactly that shape.
 */
export const scriptKindOf = (file: string): ts.ScriptKind => {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

// `setParentNodes: true` — the enclosing-function and leading-comment lookups walk upwards.
export const sourceOf = (file: string): ts.SourceFile => {
  const cached = parsed.get(file)

  if (cached) return cached

  const created = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(file),
  )

  parsed.set(file, created)

  return created
}

const specifierBase = (from: string, spec: string): string | null => {
  if (spec.startsWith('.')) return path.resolve(path.dirname(from), spec)
  if (spec === 'src' || spec.startsWith('src/')) return path.join(SRC, spec.slice(3))

  return null
}

/** Resolve a relative or `src/…` specifier to a file in this tree; anything else is a package. */
const resolveSpec = (from: string, spec: string): string | null => {
  const base = specifierBase(from, spec)

  if (base === null) return null

  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]

  return (
    candidates.find((candidate) => {
      return existsSync(candidate)
    }) ?? null
  )
}

const specifiersOf = (source: ts.SourceFile): string[] => {
  const specs: string[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.importClause?.isTypeOnly !== true) specs.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0]

      if (first && ts.isStringLiteral(first)) specs.push(first.text)
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return specs
}

/** The `name:` string of a `defineMcpTool({ … })` call, or null when it is not one. */
const definedToolName = (node: ts.Node, source: ts.SourceFile): string | null => {
  if (!ts.isCallExpression(node)) return null
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'defineMcpTool') return null

  const literal = node.arguments[0]

  if (!literal || !ts.isObjectLiteralExpression(literal)) return null

  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (property.name.getText(source) !== 'name') continue
    if (ts.isStringLiteral(property.initializer)) return property.initializer.text
  }

  return null
}

/**
 * Tool name -> the file whose `defineMcpTool({ name: … })` declares it.
 *
 * Derived, not tabulated: the catalog's `cliName` is NOT the directory name (`release-deploy-all`
 * lives in `commands/gh-release-deploy-all/`), so a path convention would have been wrong for four
 * tools on the day it was written.
 */
const declaringFiles = (): Map<string, string> => {
  const found = new Map<string, string>()

  for (const file of files) {
    const source = sourceOf(file)

    const visit = (node: ts.Node): void => {
      const name = definedToolName(node, source)

      if (name !== null) found.set(name, file)

      ts.forEachChild(node, visit)
    }

    visit(source)
  }

  return found
}

/**
 * Every catalog row that carries a tool definition — `mcpExposed` deliberately NOT consulted, so
 * `doctor` and `release-deliver` are in. G8 reads input schemas off these, and an agent can pass any
 * of those fields to the CLI whether or not the row was ever registered anywhere.
 */
export const catalogTools: CatalogMcpTool[] = commandCatalog.flatMap((entry) => {
  return entry.mcpTool ? [entry.mcpTool] : []
})

export const toolFiles = declaringFiles()

/**
 * `src/commands/<cmd>/<cmd>.ts` for every command directory. The catalog is not the source here on
 * purpose: `groupPath`/`cliName` do not name files (`merge-dev` lives in `gh-merge-dev/`), and a
 * command added to the tree but not yet to the catalog must still be swept.
 */
const commandEntryFiles = (): string[] => {
  const commandsDir = path.join(SRC, 'commands')

  return readdirSync(commandsDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return []

    const candidate = path.join(commandsDir, entry.name, `${entry.name}.ts`)

    return existsSync(candidate) ? [candidate] : []
  })
}

/**
 * `dev` has no `commands/dev/dev.ts`: `program.ts` wires it inline through a dynamic import of this
 * entry, so its whole graph (the wizard included) hangs off a file the directory convention never
 * sees. It is still one `Bash(infra-kit dev)` away.
 */
const inlineEntryFiles = [path.join(SRC, 'entry', 'dev-server.ts')]

export const reachableModules = ((): Set<string> => {
  const seen = new Set<string>()
  const pending = [...toolFiles.values(), ...commandEntryFiles(), ...inlineEntryFiles]

  while (pending.length > 0) {
    const file = pending.pop() as string

    if (seen.has(file)) continue

    seen.add(file)

    for (const spec of specifiersOf(sourceOf(file))) {
      const resolved = resolveSpec(file, spec)

      if (resolved) pending.push(resolved)
    }
  }

  return seen
})()

const enclosingName = (node: ts.Node, source: ts.SourceFile): string => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isMethodDeclaration(current)) return current.name.getText(source)

    const isFn = ts.isArrowFunction(current) || ts.isFunctionExpression(current)

    if (isFn && current.parent && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
      return current.parent.name.text
    }
  }

  return '<module>'
}

export interface PromptSite {
  /** `<file>#<enclosing fn>` — stable across edits in a way a line number is not. */
  key: string
  where: string
  /**
   * `'default'` means no `whenHeadless` was written at all, which `withEscape` reads as refuse;
   * `'argument'` is `{ refuse: '<name>' }` — a refusal that names the argument to pass.
   */
  policy: 'refuse' | 'argument' | 'value' | 'default'
  /** The string literal in a `{ refuse: '<name>' }` policy, if the site has one. */
  field: string | null
  reachable: boolean
}

/** The one `key: value` pair of a single-property object literal, or null for any other shape. */
const singleProperty = (node: ts.Expression): { key: string; value: ts.Expression } | null => {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 1) return null

  const [property] = node.properties

  if (!property || !ts.isPropertyAssignment(property)) return null

  return { key: property.name.getText(), value: property.initializer }
}

// Read off the AST, not a comment: the argument name is now part of the policy VALUE, so the site
// cannot name one thing in prose and pass another to `withEscape`.
const policyOf = (initializer: ts.Expression): { policy: PromptSite['policy']; field: string | null } => {
  if (ts.isStringLiteral(initializer)) return { policy: 'refuse', field: null }

  const pair = singleProperty(initializer)

  if (pair?.key === 'refuse' && ts.isStringLiteral(pair.value)) return { policy: 'argument', field: pair.value.text }

  return { policy: 'value', field: null }
}

const readPolicy = (
  call: ts.CallExpression,
  source: ts.SourceFile,
): { policy: PromptSite['policy']; field: string | null } => {
  const options = call.arguments[1]

  if (!options || !ts.isObjectLiteralExpression(options)) return { policy: 'default', field: null }

  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (property.name.getText(source) !== 'whenHeadless') continue

    return policyOf(property.initializer)
  }

  return { policy: 'default', field: null }
}

/** Every `withEscape(…)` call in the tree, with the policy it declares and whether an agent reaches it. */
export const promptSites: PromptSite[] = files.flatMap((file) => {
  const source = sourceOf(file)
  const found: PromptSite[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withEscape') {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      const relative = path.relative(SRC, file)

      found.push({
        key: `${relative}#${enclosingName(node, source)}`,
        where: `${relative}:${line}`,
        reachable: reachableModules.has(file),
        ...readPolicy(node, source),
      })
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return found
})

export const reachableSites = promptSites.filter((site) => {
  return site.reachable
})
