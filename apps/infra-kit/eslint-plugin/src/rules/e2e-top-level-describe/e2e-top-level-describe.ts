import type { Rule, SourceCode } from 'eslint'
import type * as ESTree from 'estree'

import { attachedStart } from '../../utils/attached-comments'
import { matchesAnyGlob } from '../../utils/path-match'
import { isInE2ePackage, playwrightCallKind, staticTitle, testStatementNames } from '../../utils/playwright-call'

export interface Options {
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
  /** Top-level `test.describe` blocks a spec may hold. */
  max?: number
}

const SPEC_FILE = /\.spec\.[cm]?[jt]sx?$/
const DEFAULT_MAX = 1

type Statement = ESTree.Statement | ESTree.ModuleDeclaration

interface TopLevelCall {
  statement: ESTree.ExpressionStatement
  call: ESTree.CallExpression
  names: string[]
}

const topLevelCalls = (body: Statement[]): TopLevelCall[] => {
  return body.flatMap((statement) => {
    const names = testStatementNames(statement)

    if (names === null) {
      return []
    }

    const expressionStatement = statement as ESTree.ExpressionStatement

    return [{ statement: expressionStatement, call: expressionStatement.expression as ESTree.CallExpression, names }]
  })
}

const describeLabel = (call: ESTree.CallExpression): string => {
  const title = staticTitle(call)

  return title === null ? 'the `test.describe` block' : `\`test.describe('${title}')\``
}

const callbackBlock = (call: ESTree.CallExpression): ESTree.BlockStatement | null => {
  const callback = call.arguments.at(-1)

  if (callback?.type !== 'ArrowFunctionExpression' && callback?.type !== 'FunctionExpression') {
    return null
  }

  return callback.body.type === 'BlockStatement' ? callback.body : null
}

/** The statement's range, widened over its attached comments and the whitespace that follows it. */
const removalRange = (sourceCode: SourceCode, statement: Statement): [number, number] => {
  const end = statement.range![1]
  const next = sourceCode.text.slice(end).search(/\S/)

  return [attachedStart(sourceCode, statement), next === -1 ? sourceCode.text.length : end + next]
}

/**
 * Moves every top-level `test.use` / `configure` / hook / annotation into the one describe, at the
 * start of its body and in source order. Equivalent while the spec has a single describe: each of
 * them then applies to exactly the tests it applied to before.
 */
const buildFix = (sourceCode: SourceCode, moved: TopLevelCall[], block: ESTree.BlockStatement): Rule.ReportFixer => {
  return (fixer) => {
    // The describe is top-level, so an empty body indents one level from column 0.
    const indent = ' '.repeat(block.body[0]?.loc?.start.column ?? 2)
    const texts = moved.map(({ statement }) => {
      const [start] = removalRange(sourceCode, statement)

      return sourceCode.text
        .slice(start, statement.range![1])
        .split('\n')
        .map((line) => {
          return line === '' ? line : `${indent}${line}`
        })
        .join('\n')
    })

    return [
      ...moved.map(({ statement }) => {
        return fixer.removeRange(removalRange(sourceCode, statement))
      }),
      fixer.insertTextAfterRange([block.range![0], block.range![0] + 1], `\n${texts.join('\n\n')}\n`),
    ]
  }
}

export const e2eTopLevelDescribe: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: {
      description:
        'Require an e2e spec to hold one top-level `test.describe`, with its `test.use`, `configure`, hooks and tests inside it.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#e2e-top-level-describe',
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
          max: {
            type: 'integer',
            minimum: 1,
            description: 'Top-level `test.describe` blocks a spec may hold.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      extraDescribe:
        '{{describe}} is top-level describe number {{count}} in this spec; the limit is {{max}}. Move it to its own spec file, or nest it inside {{first}}.',
      outsideDescribe:
        '`{{call}}` sits at the top level of the spec. Move it inside {{describe}}: a spec holds one top-level describe, and its setup, hooks and tests live inside it.',
      testOutsideDescribe:
        'Test {{test}} sits at the top level of the spec. Wrap the spec’s tests in a `test.describe` named after the feature they cover.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')

    if (!SPEC_FILE.test(filename) || (options.ignore?.length && matchesAnyGlob(filename, options.ignore))) {
      return {}
    }

    if (!isInE2ePackage(context)) {
      return {}
    }

    const max = options.max ?? DEFAULT_MAX

    return {
      Program(program) {
        const calls = topLevelCalls(program.body as Statement[])
        const describes = calls.filter(({ call }) => {
          return playwrightCallKind(call) === 'describe'
        })
        const tests = calls.filter(({ call }) => {
          return (
            playwrightCallKind(call) === 'test' &&
            call.arguments.slice(1).some((argument) => {
              return argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression'
            })
          )
        })
        const setup = calls.filter((entry) => {
          return !describes.includes(entry) && !tests.includes(entry)
        })

        for (const [index, extra] of describes.slice(max).entries()) {
          context.report({
            node: extra.statement,
            messageId: 'extraDescribe',
            data: {
              describe: describeLabel(extra.call),
              count: String(max + index + 1),
              max: String(max),
              first: describeLabel(describes[0]!.call),
            },
          })
        }

        for (const test of tests) {
          const title = staticTitle(test.call)

          context.report({
            node: test.statement,
            messageId: 'testOutsideDescribe',
            data: { test: title === null ? `\`${test.names.join('.')}\`` : `'${title}'` },
          })
        }

        const [only] = describes
        const block = describes.length === 1 && only ? callbackBlock(only.call) : null
        const fix = block === null ? undefined : buildFix(context.sourceCode, setup, block)

        for (const entry of setup) {
          context.report({
            node: entry.statement,
            messageId: 'outsideDescribe',
            data: {
              call: entry.names.join('.'),
              describe: only ? describeLabel(only.call) : 'a `test.describe` block',
            },
            fix,
          })
        }
      },
    }
  },
}
