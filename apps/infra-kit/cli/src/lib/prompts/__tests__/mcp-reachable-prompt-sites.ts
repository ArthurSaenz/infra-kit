import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

import { getExposedMcpTools } from 'src/lib/command-catalog'

/**
 * @fileoverview
 * Shared machinery for the two guards that need to know WHICH `withEscape` call sites an MCP
 * agent can actually reach: the headless-policy sweep in
 * `every-inquirer-site-is-escapable.test.ts` and the G6/G8 claim checks in
 * `headless-policy-guards.test.ts`.
 *
 * Not a `.test.ts`, so vitest's default include glob does not collect it, and it sits under
 * `__tests__/` so both sweeps' walkers skip it — this file can never become its own subject.
 *
 * REACHABILITY IS MODULE-LEVEL, and deliberately so: roots are the files that declare an exposed
 * tool via `defineMcpTool({ name })`, and the closure follows value imports, re-exports and dynamic
 * `import(…)`. It is an OVER-approximation — a barrel drags in siblings the command never calls, so
 * `lib/release-deploy/source-picker.ts` counts as reachable through `lib/release-deploy/index.ts`
 * even though only the unexposed merged `release-deploy` command calls it. Over-approximating is the
 * safe direction: it can demand an annotation nobody needed, never miss one that was.
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

// `setParentNodes: true` — the enclosing-function and leading-comment lookups walk upwards.
export const sourceOf = (file: string): ts.SourceFile => {
  const cached = parsed.get(file)

  if (cached) return cached

  const created = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

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

/** The live registration set — `mcpExposed` filtered, so `doctor` is absent by construction. */
export const exposedTools = getExposedMcpTools()

export const toolFiles = declaringFiles()

export const reachableModules = ((): Set<string> => {
  const seen = new Set<string>()
  const pending = exposedTools.flatMap((tool) => {
    const file = toolFiles.get(tool.name)

    return file ? [file] : []
  })

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

/** Every `// MCP-unreachable: …` line attached to a node, as one string. */
const unreachableComments = (node: ts.Node, source: ts.SourceFile): string => {
  const text = source.getFullText()
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []

  return ranges
    .map((range) => {
      return text.slice(range.pos, range.end)
    })
    .filter((comment) => {
      return comment.includes('MCP-unreachable:')
    })
    .join('\n')
}

export interface PromptSite {
  /** `<file>#<enclosing fn>` — stable across edits in a way a line number is not. */
  key: string
  where: string
  /** `'default'` means no `whenHeadless` was written at all, which `withEscape` reads as refuse. */
  policy: 'refuse' | 'unreachable' | 'value' | 'default'
  /** The backticked identifier in the site's `// MCP-unreachable:` comment, if it has one. */
  field: string | null
  reachable: boolean
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

    const policy = ts.isStringLiteral(property.initializer)
      ? (property.initializer.text as 'refuse' | 'unreachable')
      : ('value' as const)
    const comment = `${unreachableComments(options, source)}\n${unreachableComments(property, source)}`

    return { policy, field: /`([A-Z]\w*)`/i.exec(comment)?.[1] ?? null }
  }

  return { policy: 'default', field: null }
}

/** Every `withEscape(…)` call in the tree, with the policy it declares and whether MCP reaches it. */
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
