import type { Rule } from 'eslint'

import { isInE2ePackage, playwrightCallKind, staticTitle } from '../../utils/playwright-call'

const SHOULD_PREFIX = /^should\s+/i

export const e2eTestTitle: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require e2e test titles to state the behaviour directly, without a leading `should`.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#e2e-test-title',
    },
    schema: [],
    messages: {
      shouldPrefix:
        'Test title "{{title}}" starts with `should`. State the behaviour and its observable outcome directly: "{{suggested}}".',
    },
  },

  create(context) {
    if (!isInE2ePackage(context)) {
      return {}
    }

    return {
      CallExpression(node) {
        const title = playwrightCallKind(node) === 'test' ? staticTitle(node) : null

        if (title === null || !SHOULD_PREFIX.test(title)) {
          return
        }

        context.report({
          node: node.arguments[0] ?? node,
          messageId: 'shouldPrefix',
          data: { title, suggested: title.replace(SHOULD_PREFIX, '') },
        })
      },
    }
  },
}
