import type { Rule } from 'eslint'
import type { Expression, Node, ObjectExpression, SpreadElement } from 'estree'

import { detailsArgument, isInE2ePackage, playwrightCallKind } from '../../utils/playwright-call'

export interface Options {
  /** The only tags a test or describe may carry. */
  allowed?: string[]
}

export const DEFAULT_ALLOWED_TAGS = ['@smoke', '@readonly', '@mocked', '@slow']

/** The `tag` property's value node, or null when the details object has none. */
const tagValue = (details: ObjectExpression): Expression | null => {
  for (const property of details.properties) {
    if (
      property.type === 'Property' &&
      !property.computed &&
      property.key.type === 'Identifier' &&
      property.key.name === 'tag'
    ) {
      return property.value as Expression
    }
  }

  return null
}

/** String-literal tags with their nodes; non-literal entries (a shared constant) are not judged. */
const literalTags = (value: Expression): { tag: string; node: Node }[] => {
  const entries: (Expression | SpreadElement | null)[] = value.type === 'ArrayExpression' ? value.elements : [value]

  return entries.flatMap((entry) => {
    return entry?.type === 'Literal' && typeof entry.value === 'string' ? [{ tag: entry.value, node: entry }] : []
  })
}

export const e2eTestTags: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Restrict Playwright test and describe tags in e2e packages to an allowed set.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#e2e-test-tags',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowed: {
            type: 'array',
            items: { type: 'string', pattern: '^@' },
            uniqueItems: true,
            description: 'The only tags allowed; defaults to @smoke, @readonly, @mocked, @slow.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unknownTag:
        'Tag `{{tag}}` is not an allowed e2e tag. Use one of {{allowed}}; browsers, devices and environments are Playwright projects, not tags.',
    },
  },

  create(context) {
    if (!isInE2ePackage(context)) {
      return {}
    }

    const options = (context.options[0] ?? {}) as Options
    const allowed = new Set(options.allowed ?? DEFAULT_ALLOWED_TAGS)
    const allowedList = [...allowed]
      .map((tag) => {
        return `\`${tag}\``
      })
      .join(', ')

    return {
      CallExpression(node) {
        const details = playwrightCallKind(node) === null ? null : detailsArgument(node)
        const value = details === null ? null : tagValue(details)

        if (value === null) {
          return
        }

        for (const { tag, node: tagNode } of literalTags(value)) {
          if (!allowed.has(tag)) {
            context.report({ node: tagNode, messageId: 'unknownTag', data: { tag, allowed: allowedList } })
          }
        }
      },
    }
  },
}
