import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { matchesAnyGlob } from '../../utils/path-match'
import { isInE2ePackage, playwrightCallKind, staticTitle, testStatementNames } from '../../utils/playwright-call'

export interface Options {
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

const SPEC_FILE = /\.spec\.[cm]?[jt]sx?$/

const SETUP_RANK = 0
const BODY_RANK = 5
const HOOK_RANK: Record<string, number> = { beforeAll: 1, beforeEach: 2, afterEach: 3, afterAll: 4 }
const SETUP_CALLS = new Set(['use', 'configure', 'setTimeout', 'slow'])
// Without a test callback these annotate the block (`test.skip(isMobile, '…')`) instead of declaring a test.
const ANNOTATION_CALLS = new Set(['skip', 'fixme', 'fail'])

const RANK_NAMES = ['setup', 'beforeAll hook', 'beforeEach hook', 'afterEach hook', 'afterAll hook', 'test']

interface Ranked {
  rank: number
  label: string
}

const isFunction = (node: ESTree.Node | undefined): boolean => {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'
}

const rankFor = (method: string, call: ESTree.CallExpression): number => {
  if (method in HOOK_RANK) {
    return HOOK_RANK[method]!
  }

  const declaresTest = call.arguments.slice(1).some(isFunction)

  return SETUP_CALLS.has(method) || (ANNOTATION_CALLS.has(method) && !declaresTest) ? SETUP_RANK : BODY_RANK
}

/** A statement's slot in a describe body, or null when it is not a `test.*` call. */
const rankOf = (statement: ESTree.Statement): Ranked | null => {
  const names = testStatementNames(statement)

  if (names === null) {
    return null
  }

  const call = (statement as ESTree.ExpressionStatement).expression as ESTree.CallExpression
  const rank = rankFor(names.at(-1)!, call)
  const title = rank === BODY_RANK ? staticTitle(call) : null
  const label = title === null ? `\`${names.join('.')}\`` : `\`${names.join('.')}('${title}')\``

  return { rank, label: `${label} (${RANK_NAMES[rank]})` }
}

const describeBody = (call: ESTree.CallExpression): ESTree.Statement[] | null => {
  const callback = call.arguments.at(-1)

  if (callback?.type !== 'ArrowFunctionExpression' && callback?.type !== 'FunctionExpression') {
    return null
  }

  return callback.body.type === 'BlockStatement' ? callback.body.body : null
}

export const e2eDescribeOrder: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Order an e2e `test.describe` body: `test.use` / `configure` / annotations, then hooks beforeAll → beforeEach → afterEach → afterAll, then tests and nested describes.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#e2e-describe-order',
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
      outOfOrder:
        '{{label}} comes after {{afterLabel}} in describe {{describe}}. Order a describe body: `test.use` / `test.describe.configure` / annotations, then hooks beforeAll → beforeEach → afterEach → afterAll, then tests and nested describes.',
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

    return {
      CallExpression(node) {
        const body = playwrightCallKind(node) === 'describe' ? describeBody(node) : null

        if (body === null) {
          return
        }

        const title = staticTitle(node)
        const describe = title === null ? 'block' : `'${title}'`
        let latest: Ranked | null = null

        for (const statement of body) {
          const ranked = rankOf(statement)

          if (ranked === null) {
            continue
          }

          if (latest !== null && ranked.rank < latest.rank) {
            context.report({
              node: statement,
              messageId: 'outOfOrder',
              data: {
                label: ranked.label,
                afterLabel: latest.label,
                describe,
              },
            })
          } else {
            latest = ranked
          }
        }
      },
    }
  },
}
