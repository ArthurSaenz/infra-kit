import type { Rule, SourceCode } from 'eslint'
import type * as ESTree from 'estree'

import { attachedStart } from '../../utils/attached-comments'
import { matchesAnyGlob } from '../../utils/path-match'
import { isInE2ePackage } from '../../utils/playwright-call'

export interface Options {
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

type Member = ESTree.MethodDefinition | ESTree.PropertyDefinition | ESTree.StaticBlock

// TS-only member fields are not modelled by estree; read them structurally.
interface TsMember {
  type: string
  kind?: string
  accessibility?: 'public' | 'protected' | 'private'
  key?: ESTree.Node
}

const PAGE_OBJECT_FILE = /\.(?:page|component)\.[cm]?[jt]sx?$/

const GROUPS = ['field', 'constructor', 'getter', 'public method', 'private method'] as const

type Group = (typeof GROUPS)[number]

const isPrivate = (member: TsMember): boolean => {
  return (
    member.accessibility === 'private' ||
    member.accessibility === 'protected' ||
    member.key?.type === 'PrivateIdentifier'
  )
}

/**
 * A member's group. A property is a field even when it holds an arrow function: properties initialize
 * in source order, so moving one past another could break an initializer that reads it.
 */
const groupOf = (member: TsMember): Group => {
  if (member.kind === 'constructor') {
    return 'constructor'
  }

  if (member.type !== 'MethodDefinition') {
    return 'field'
  }

  if (isPrivate(member)) {
    return 'private method'
  }

  return member.kind === 'get' || member.kind === 'set' ? 'getter' : 'public method'
}

const memberName = (member: TsMember): string => {
  if (member.kind === 'constructor') {
    return 'the constructor'
  }

  const key = member.key

  if (key?.type === 'Identifier') {
    return `\`${key.name}\``
  }

  return key?.type === 'PrivateIdentifier' ? `\`#${key.name}\`` : 'a computed member'
}

/**
 * Reorders the members into the group order. Each member keeps its own comments; the text between
 * members (blank lines, indentation) stays where it was. Sorting is stable, so fields keep their
 * relative order and field initializers see the same `this` they did before.
 */
const buildFix = (sourceCode: SourceCode, members: Member[]): Rule.ReportFixer => {
  return (fixer) => {
    const spans = members.map((_, index) => {
      return [attachedStart(sourceCode, members[index]!), members[index]!.range![1]] as [number, number]
    })
    const texts = spans.map(([start, end]) => {
      return sourceCode.text.slice(start, end)
    })
    const order = members
      .map((member, index) => {
        return { index, rank: GROUPS.indexOf(groupOf(member as TsMember)) }
      })
      .toSorted((a, b) => {
        return a.rank - b.rank || a.index - b.index
      })

    return spans.map((span, slot) => {
      return fixer.replaceTextRange(span, texts[order[slot]!.index]!)
    })
  }
}

interface Violation {
  member: Member
  group: Group
  after: Member
  afterGroup: Group
}

const findViolations = (members: Member[]): Violation[] => {
  const violations: Violation[] = []
  let latest: { member: Member; group: Group } | null = null

  for (const member of members) {
    const group = groupOf(member as TsMember)

    if (latest !== null && GROUPS.indexOf(group) < GROUPS.indexOf(latest.group)) {
      violations.push({ member, group, after: latest.member, afterGroup: latest.group })
    } else {
      latest = { member, group }
    }
  }

  return violations
}

export const e2ePageObjectMemberOrder: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: {
      description:
        'Order the members of an e2e page object: fields, the constructor, getters, public methods, then private methods.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#e2e-page-object-member-order',
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
        'The {{group}} {{name}} comes after the {{afterGroup}} {{afterName}} in class `{{className}}`. Order a page object: fields, constructor, getters, public methods, private methods.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')

    if (!PAGE_OBJECT_FILE.test(filename) || (options.ignore?.length && matchesAnyGlob(filename, options.ignore))) {
      return {}
    }

    if (!isInE2ePackage(context)) {
      return {}
    }

    const check = (node: ESTree.ClassDeclaration | ESTree.ClassExpression): void => {
      const members = node.body.body as Member[]
      const violations = findViolations(members)

      if (violations.length === 0) {
        return
      }

      const fix = buildFix(context.sourceCode, members)

      for (const violation of violations) {
        context.report({
          node: violation.member,
          messageId: 'outOfOrder',
          data: {
            group: violation.group,
            name: memberName(violation.member as TsMember),
            afterGroup: violation.afterGroup,
            afterName: memberName(violation.after as TsMember),
            className: node.id?.name ?? 'anonymous',
          },
          fix,
        })
      }
    }

    return {
      ClassDeclaration: check,
      ClassExpression: check,
    }
  },
}
