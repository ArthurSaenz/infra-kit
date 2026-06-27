import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import type { ComponentFunction } from '../../utils/component'
import { isComponent } from '../../utils/component'

/** Whether a statement is `const { ... } = props` (destructuring the `props` identifier). */
const isPropsDestructuring = (statement: ESTree.Statement): boolean => {
  if (statement.type !== 'VariableDeclaration') {
    return false
  }

  return statement.declarations.some((declaration) => {
    return (
      declaration.id.type === 'ObjectPattern' &&
      declaration.init?.type === 'Identifier' &&
      declaration.init.name === 'props'
    )
  })
}

export const propsDestructuringBlankLine: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require a blank line after the `const { ... } = props` destructuring statement at the top of a React component body.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#props-destructuring-blank-line',
    },
    fixable: 'whitespace',
    schema: [],
    messages: {
      blankLineAfterProps: 'Add a blank line after destructuring props.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode

    const check = (node: ComponentFunction): void => {
      if (node.body.type !== 'BlockStatement') {
        return
      }

      if (!isComponent(node)) {
        return
      }

      const statements = node.body.body
      const index = statements.findIndex(isPropsDestructuring)

      if (index === -1) {
        return
      }

      const propsStatement = statements[index]
      const nextStatement = statements[index + 1]

      // `propsStatement` is defined because `index !== -1`; the guard also narrows the type.
      // Nothing follows the destructuring — no separation needed.
      if (!propsStatement || !nextStatement) {
        return
      }

      // The token/comment that follows the destructuring statement; a comment on the
      // next line still counts as "no blank line" until it is pushed down.
      const tokenAfter = sourceCode.getTokenAfter(propsStatement, { includeComments: true })
      const referenceLine = (tokenAfter ?? nextStatement).loc!.start.line

      if (referenceLine - propsStatement.loc!.end.line >= 2) {
        return
      }

      context.report({
        node: propsStatement,
        messageId: 'blankLineAfterProps',
        fix(fixer) {
          return fixer.insertTextAfter(propsStatement, '\n')
        },
      })
    }

    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
    }
  },
}
