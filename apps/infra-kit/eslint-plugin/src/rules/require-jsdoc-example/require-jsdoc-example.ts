import type { Rule, SourceCode } from 'eslint'
import type * as ESTree from 'estree'

import { cognitiveComplexity } from '../../utils/cognitive-complexity'
import type { FunctionNode } from '../../utils/cognitive-complexity'
import { matchesAnyGlob } from '../../utils/path-match'

interface Options {
  minComplexity?: number
  exampleComplexity?: number
  paths?: string[]
  ignore?: string[]
}

// Defaults chosen so only genuinely "substantial" functions are flagged, and only the
// most complex of those are pushed to also carry a worked `@example`.
const DEFAULT_MIN_COMPLEXITY = 8
const DEFAULT_EXAMPLE_COMPLEXITY = 12

type MessageId = 'missingExample' | 'missingJsdoc'

interface Settings {
  minComplexity: number
  exampleComplexity: number
}

interface Target {
  fn: FunctionNode
  name: string
  // Nodes whose leading comments may carry the qualifying JSDoc (declaration + any `export` wrapper).
  anchors: ESTree.Node[]
}

interface Violation {
  messageId: MessageId
  data: Record<string, number | string>
}

const isTargetFn = (node: ESTree.Node | null | undefined): node is FunctionNode => {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'
}

/** Split a top-level statement into its inner declaration and any `export` wrapper. */
const getExportInfo = (
  statement: ESTree.Statement | ESTree.ModuleDeclaration,
): { exportStmt: ESTree.Node | null; declaration: ESTree.Node | null } => {
  if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') {
    return { exportStmt: statement, declaration: (statement.declaration as ESTree.Node | null) ?? null }
  }

  return { exportStmt: null, declaration: statement }
}

/** The named, definable functions declared by a single top-level declaration. */
const targetsFromDeclaration = (declaration: ESTree.Node, anchors: ESTree.Node[]): Target[] => {
  if (declaration.type === 'FunctionDeclaration') {
    return declaration.id ? [{ fn: declaration, name: declaration.id.name, anchors }] : []
  }

  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((declarator) => {
      return declarator.id.type === 'Identifier' && isTargetFn(declarator.init)
        ? [{ fn: declarator.init, name: declarator.id.name, anchors }]
        : []
    })
  }

  return []
}

/** Every named top-level function definition (bare or `export`/`export default` wrapped). */
const collectTargets = (body: Array<ESTree.Statement | ESTree.ModuleDeclaration>): Target[] => {
  return body.flatMap((statement) => {
    const { exportStmt, declaration } = getExportInfo(statement)

    if (!declaration) {
      return []
    }

    const anchors = exportStmt ? [exportStmt, declaration] : [declaration]

    return targetsFromDeclaration(declaration, anchors)
  })
}

/** Whether a `/** … *\/` JSDoc block immediately precedes any anchor. */
const hasJsdocBlock = (sourceCode: SourceCode, anchors: ESTree.Node[]): boolean => {
  return anchors.some((anchor) => {
    return sourceCode.getCommentsBefore(anchor).some((comment) => {
      return comment.type === 'Block' && comment.value.startsWith('*')
    })
  })
}

/** Whether such a leading JSDoc block ALSO carries an `@example` tag. */
const hasJsdocExample = (sourceCode: SourceCode, anchors: ESTree.Node[]): boolean => {
  return anchors.some((anchor) => {
    return sourceCode.getCommentsBefore(anchor).some((comment) => {
      return comment.type === 'Block' && comment.value.startsWith('*') && comment.value.includes('@example')
    })
  })
}

/** Decide whether a target violates the rule and, if so, which message fits. */
const decideViolation = (target: Target, settings: Settings, sourceCode: SourceCode): Violation | null => {
  const complexity = cognitiveComplexity(target.fn, target.name)
  const { minComplexity, exampleComplexity } = settings

  // Below the floor: no documentation requirement at all.
  if (complexity < minComplexity) {
    return null
  }

  const { name } = target

  // A missing block always takes precedence over a missing `@example`.
  if (!hasJsdocBlock(sourceCode, target.anchors)) {
    return { messageId: 'missingJsdoc', data: { name, complexity, minComplexity } }
  }

  if (complexity >= exampleComplexity && !hasJsdocExample(sourceCode, target.anchors)) {
    return { messageId: 'missingExample', data: { name, complexity, exampleComplexity } }
  }

  return null
}

export const requireJsdocExample: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Graduated JSDoc requirement by cognitive complexity: at or above `minComplexity` a function must carry a leading JSDoc block, and at or above `exampleComplexity` that block must also include an `@example` tag.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#require-jsdoc-example',
    },
    schema: [
      {
        type: 'object',
        properties: {
          minComplexity: {
            type: 'integer',
            minimum: 1,
            description: 'Cognitive complexity at or above which a function must carry a leading JSDoc block.',
          },
          exampleComplexity: {
            type: 'integer',
            minimum: 1,
            description: 'Cognitive complexity at or above which the JSDoc block must also include an `@example` tag.',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional glob patterns. When provided, the rule only runs for files whose path matches one of them.',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional glob patterns. The rule is skipped for files whose path matches one of them, even if it also matches `paths`.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingJsdoc:
        'function "{{name}}" has cognitive complexity {{complexity}} (>= {{minComplexity}}); add a JSDoc block documenting it.',
      missingExample:
        'function "{{name}}" has cognitive complexity {{complexity}} (>= {{exampleComplexity}}); its JSDoc block needs an `@example` documenting usage.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const paths = options.paths ?? []
    const ignore = options.ignore ?? []

    // `ignore` takes precedence: skip excluded files even when they also match `paths`.
    if (ignore.length > 0 && matchesAnyGlob(context.filename, ignore)) {
      return {}
    }

    if (paths.length > 0 && !matchesAnyGlob(context.filename, paths)) {
      return {}
    }

    const settings: Settings = {
      minComplexity: options.minComplexity ?? DEFAULT_MIN_COMPLEXITY,
      exampleComplexity: options.exampleComplexity ?? DEFAULT_EXAMPLE_COMPLEXITY,
    }

    const { sourceCode } = context

    return {
      Program(program) {
        for (const target of collectTargets(program.body)) {
          const violation = decideViolation(target, settings, sourceCode)

          if (violation) {
            context.report({ node: target.fn, messageId: violation.messageId, data: violation.data })
          }
        }
      },
    }
  },
}
