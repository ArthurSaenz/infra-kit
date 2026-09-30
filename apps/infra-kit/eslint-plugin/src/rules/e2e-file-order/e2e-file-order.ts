import type { Rule, Scope, SourceCode } from 'eslint'
import type * as ESTree from 'estree'

import { attachedStart } from '../../utils/attached-comments'
import { matchesAnyGlob } from '../../utils/path-match'
import { isInE2ePackage, playwrightCallKind } from '../../utils/playwright-call'

export interface Options {
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

type Statement = ESTree.Statement | ESTree.ModuleDeclaration
type FileKind = 'pageObject' | 'fixture' | 'spec' | 'mock' | 'lib'
type AnchorKind = Exclude<FileKind, 'lib'>

// TS-only nodes are not modelled by estree; read them structurally.
interface TsNode {
  type: string
  id?: { name?: string } | null
  static?: boolean
  value?: unknown
  typeArguments?: { params: TsNode[] }
  typeName?: { type: string; name?: string }
  types?: TsNode[]
}

interface Anchor {
  index: number
  label: string
  /** Type names the anchor is declared with (a fixture's `extend<…>` argument); they may precede it. */
  headerTypes: Set<string>
}

const FILE_KIND: readonly (readonly [RegExp, FileKind])[] = [
  [/\.(?:page|component)\.[cm]?[jt]sx?$/, 'pageObject'],
  [/\.fixture\.[cm]?[jt]sx?$/, 'fixture'],
  [/\.spec\.[cm]?[jt]sx?$/, 'spec'],
  [/\.mock\.[cm]?[jt]sx?$/, 'mock'],
]

const LIB_DIR = /\/lib\//
// Fixed-content files with no single main declaration to lead with.
const UNORDERED_FILE = /\.data\.[cm]?[jt]sx?$/

const KIND_OPENING: Record<FileKind, string> = {
  pageObject: 'a page object file opens with its imports, then the class',
  fixture: 'a fixture file opens with its imports, then the fixtures type and the `extend` call',
  spec: 'a spec file opens with its imports, then its `test.*` calls',
  mock: 'a mock file opens with its imports, then the exported mock function',
  lib: 'a lib file opens with its imports, then its exports',
}

const fileKindOf = (filename: string): FileKind | null => {
  const match = FILE_KIND.find(([pattern]) => {
    return pattern.test(filename)
  })

  if (match) {
    return match[1]
  }

  return LIB_DIR.test(filename) && !UNORDERED_FILE.test(filename) ? 'lib' : null
}

const unwrapExport = (statement: Statement): ESTree.Node => {
  const isExport = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'

  return isExport && statement.declaration ? (statement.declaration as ESTree.Node) : statement
}

/** The root identifier of a call chain: `test` for `test.describe.configure(…)`. */
const calleeRoot = (callee: ESTree.Node): string | null => {
  if (callee.type === 'Identifier') {
    return callee.name
  }

  if (callee.type === 'MemberExpression') {
    return calleeRoot(callee.object)
  }

  return callee.type === 'CallExpression' ? calleeRoot(callee.callee) : null
}

const typeNamesOf = (node: TsNode | undefined): string[] => {
  if (node === undefined) {
    return []
  }

  if (node.type === 'TSTypeReference' && node.typeName?.type === 'Identifier') {
    return [node.typeName.name!]
  }

  return (node.types ?? []).flatMap(typeNamesOf)
}

const pageObjectAnchor = (declaration: ESTree.Node, index: number): Anchor | null => {
  if (declaration.type !== 'ClassDeclaration') {
    return null
  }

  return { index, label: `class \`${declaration.id?.name ?? 'default'}\``, headerTypes: new Set() }
}

const fixtureAnchor = (declaration: ESTree.Node, index: number): Anchor | null => {
  if (declaration.type !== 'VariableDeclaration') {
    return null
  }

  const [declarator] = declaration.declarations
  const init = declarator?.init

  if (init?.type !== 'CallExpression' || init.callee.type !== 'MemberExpression') {
    return null
  }

  const property = init.callee.property

  if (property.type !== 'Identifier' || property.name !== 'extend') {
    return null
  }

  const name = declarator!.id.type === 'Identifier' ? declarator!.id.name : 'test'
  const typeArguments = (init as unknown as TsNode).typeArguments?.params ?? []

  return { index, label: `fixture \`${name}\``, headerTypes: new Set(typeArguments.flatMap(typeNamesOf)) }
}

const specAnchor = (statement: Statement, index: number): Anchor | null => {
  if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression') {
    return null
  }

  if (calleeRoot(statement.expression.callee) !== 'test') {
    return null
  }

  return { index, label: 'the first `test.*` call', headerTypes: new Set() }
}

const isFunctionValue = (node: ESTree.Node | null | undefined): boolean => {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'
}

const mockAnchor = (statement: Statement, index: number): Anchor | null => {
  if (statement.type !== 'ExportNamedDeclaration' && statement.type !== 'ExportDefaultDeclaration') {
    return null
  }

  const declaration = unwrapExport(statement)

  if (declaration.type === 'FunctionDeclaration') {
    return { index, label: `mock \`${declaration.id?.name ?? 'default'}\``, headerTypes: new Set() }
  }

  const declarator = declaration.type === 'VariableDeclaration' ? declaration.declarations[0] : undefined

  if (declarator?.id.type !== 'Identifier' || !isFunctionValue(declarator.init)) {
    return null
  }

  return { index, label: `mock \`${declarator.id.name}\``, headerTypes: new Set() }
}

const ANCHOR_FINDERS: Record<AnchorKind, (statement: Statement, index: number) => Anchor | null> = {
  pageObject: (statement, index) => {
    return pageObjectAnchor(unwrapExport(statement), index)
  },
  fixture: (statement, index) => {
    return fixtureAnchor(unwrapExport(statement), index)
  },
  spec: specAnchor,
  mock: mockAnchor,
}

const findAnchor = (body: Statement[], kind: AnchorKind): Anchor | null => {
  for (const [index, statement] of body.entries()) {
    const anchor = ANCHOR_FINDERS[kind](statement, index)

    if (anchor !== null) {
      return anchor
    }
  }

  return null
}

const isDirective = (statement: Statement): boolean => {
  return (
    statement.type === 'ExpressionStatement' &&
    statement.expression.type === 'Literal' &&
    typeof statement.expression.value === 'string'
  )
}

interface Misplaced {
  candidates: number[]
  /** What the misplaced statements must follow, as the report names it. */
  target: string
}

const anchoredCandidates = (body: Statement[], kind: AnchorKind): Misplaced | null => {
  const anchor = findAnchor(body, kind)

  if (anchor === null) {
    return null
  }

  const candidates = body.slice(0, anchor.index).flatMap((statement, index) => {
    const declaration = unwrapExport(statement) as TsNode

    const isHeader =
      statement.type === 'ImportDeclaration' ||
      isDirective(statement) ||
      (declaration.id?.name !== undefined && anchor.headerTypes.has(declaration.id.name))

    return isHeader ? [] : [index]
  })

  return { candidates, target: anchor.label }
}

/** Names a local `export { a, b as c }` list exports, so `const a` below counts as an export. */
const locallyExportedNames = (body: Statement[]): Set<string> => {
  const names = body.flatMap((statement) => {
    if (statement.type !== 'ExportNamedDeclaration' || statement.source) {
      return []
    }

    return statement.specifiers.flatMap((specifier) => {
      return specifier.local.type === 'Identifier' ? [specifier.local.name] : []
    })
  })

  return new Set(names)
}

const declaredNames = (statement: Statement): string[] => {
  const declaration = unwrapExport(statement) as TsNode & ESTree.Node

  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((declarator) => {
      return declarator.id.type === 'Identifier' ? [declarator.id.name] : []
    })
  }

  return declaration.id?.name ? [declaration.id.name] : []
}

/** A lib file's private statements that sit above one of its exports. */
const libCandidates = (body: Statement[]): Misplaced | null => {
  const exportedNames = locallyExportedNames(body)
  const isExported = (statement: Statement): boolean => {
    return (
      statement.type.startsWith('Export') ||
      declaredNames(statement).some((name) => {
        return exportedNames.has(name)
      })
    )
  }
  const lastExport = body.findLastIndex(isExported)

  if (lastExport === -1) {
    return null
  }

  const candidates = body.slice(0, lastExport).flatMap((statement, index) => {
    return statement.type === 'ImportDeclaration' || isDirective(statement) || isExported(statement) ? [] : [index]
  })

  return { candidates, target: 'the exports' }
}

const misplacedStatements = (body: Statement[], kind: FileKind): Misplaced | null => {
  return kind === 'lib' ? libCandidates(body) : anchoredCandidates(body, kind)
}

/**
 * Whether a function passed to — or invoked as — `call` runs as part of it. Playwright runs every
 * `test.*` callback later, except a `describe` body; any other callback (`forEach`, `map`, an IIFE)
 * is assumed to run on the spot.
 */
const runsWithCall = (fn: ESTree.Node, call: ESTree.CallExpression): boolean => {
  if (call.callee === fn || playwrightCallKind(call) === 'describe') {
    return true
  }

  return calleeRoot(call.callee) !== 'test'
}

const isFunctionNode = (node: ESTree.Node): boolean => {
  return (
    node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration'
  )
}

/** Whether `node` is evaluated while the module loads, rather than later from a function or instance. */
const runsAtLoad = (node: ESTree.Node): boolean => {
  let child: ESTree.Node = node
  let parent = (node as Rule.Node).parent as ESTree.Node | null | undefined

  while (parent) {
    if (isFunctionNode(child)) {
      if (parent.type !== 'CallExpression' || !runsWithCall(child, parent)) {
        return false
      }
    }

    const tsParent = parent as unknown as TsNode

    if (tsParent.type === 'PropertyDefinition' && tsParent.value === child && !tsParent.static) {
      return false
    }

    child = parent
    parent = (parent as Rule.Node).parent as ESTree.Node | null | undefined
  }

  return true
}

const topLevelIndex = (node: ESTree.Node, body: Statement[]): number => {
  let current = node as Rule.Node

  while (current.parent && current.parent.type !== 'Program') {
    current = current.parent
  }

  return body.indexOf(current as Statement)
}

const valueReferences = (sourceCode: SourceCode, statement: Statement): Scope.Reference[] => {
  return sourceCode.getDeclaredVariables(unwrapExport(statement)).flatMap((variable) => {
    return variable.references.filter((reference) => {
      const tsReference = reference as Scope.Reference & { isValueReference?: boolean }

      return tsReference.isValueReference !== false && reference.identifier !== variable.identifiers[0]
    })
  })
}

/**
 * Narrows the stray candidates to the ones that can move to the end of the file. A binding stays
 * put when it is read while the module loads — a `describe` title, `test.use({…})`, a loop inside
 * `describe`, a `static` field, an `extend` option — since a `const` below that point is in its TDZ.
 * Any read from a statement that stays counts, so a kept helper keeps what it closes over.
 */
const movableStrays = (sourceCode: SourceCode, body: Statement[], candidates: number[]): Set<number> => {
  const movable = new Set(candidates)
  let changed = true

  while (changed) {
    changed = false

    for (const index of movable) {
      const pinned = valueReferences(sourceCode, body[index]!).some((reference) => {
        const from = topLevelIndex(reference.identifier as ESTree.Node, body)

        return !movable.has(from) && (candidates.includes(from) || runsAtLoad(reference.identifier as ESTree.Node))
      })

      if (pinned) {
        movable.delete(index)
        changed = true
      }
    }
  }

  return movable
}

const describeStatement = (statement: Statement): string => {
  const names = declaredNames(statement)

  if (names.length > 0) {
    return names
      .map((name) => {
        return `\`${name}\``
      })
      .join(', ')
  }

  return `a ${unwrapExport(statement).type} statement`
}

/** The statement's source range, widened over its attached comments and a same-line trailing one. */
const statementSpan = (sourceCode: SourceCode, statement: Statement): [number, number] => {
  const trailing = sourceCode.getCommentsAfter(statement).filter((comment) => {
    return comment.loc!.start.line === statement.loc!.end.line
  })

  return [attachedStart(sourceCode, statement), (trailing.at(-1) ?? statement).range![1]]
}

const buildFix = (sourceCode: SourceCode, body: Statement[], movable: number[]): Rule.ReportFixer => {
  return (fixer) => {
    const spans = movable.map((index) => {
      return statementSpan(sourceCode, body[index]!)
    })
    const moved = spans.map(([start, end]) => {
      return sourceCode.text.slice(start, end)
    })
    const end = sourceCode.text.length
    const separator = sourceCode.text.endsWith('\n') ? '\n' : '\n\n'

    return [
      ...spans.map(([start, stop]) => {
        const next = sourceCode.text.slice(stop).search(/\S/)

        return fixer.removeRange([start, next === -1 ? end : stop + next])
      }),
      fixer.insertTextAfterRange([end, end], `${separator}${moved.join('\n\n')}\n`),
    ]
  }
}

export const e2eFileOrder: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: {
      description:
        'Require e2e page objects, fixtures, specs, mocks and lib files to open with their imports followed by the class, the `extend` call, the `test.*` calls, the mock function or the exports — helpers and constants go below.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#e2e-file-order',
    },
    schema: [
      {
        type: 'object',
        properties: {
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional globs; the rule is skipped for matching files.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      strayBeforeAnchor:
        '{{name}} sits between the imports and {{anchor}}. Move it below {{anchor}}: {{opening}}. The autofix moves it to the end of the file.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')
    const kind = fileKindOf(filename)

    if (kind === null || (options.ignore?.length && matchesAnyGlob(filename, options.ignore))) {
      return {}
    }

    if (!isInE2ePackage(context)) {
      return {}
    }

    return {
      Program(program) {
        const body = program.body as Statement[]
        const misplaced = misplacedStatements(body, kind)

        if (misplaced === null) {
          return
        }

        const movable = [...movableStrays(context.sourceCode, body, misplaced.candidates)].toSorted((a, b) => {
          return a - b
        })

        if (movable.length === 0) {
          return
        }

        const fix = buildFix(context.sourceCode, body, movable)

        for (const index of movable) {
          context.report({
            node: body[index]!,
            messageId: 'strayBeforeAnchor',
            data: { name: describeStatement(body[index]!), anchor: misplaced.target, opening: KIND_OPENING[kind] },
            fix,
          })
        }
      },
    }
  },
}
