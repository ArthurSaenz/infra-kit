import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import type { ComponentFunction } from '../../utils/component'
import { isComponent } from '../../utils/component'

// Minimal structural views over nodes that estree's types do not fully model:
// the optional TS type annotation and `range` that the parser attaches to params.
interface WithRange {
  range?: [number, number]
}
type AnnotatedPattern = ESTree.ObjectPattern & { typeAnnotation?: ESTree.Node & WithRange } & WithRange

// Recursively collect every identifier a destructuring pattern binds, so we can detect
// whether it already introduces a `props` binding (e.g. a `...props` rest).
const collectBoundNames = (node: ESTree.Node | null, names: Set<string>): void => {
  if (!node) {
    return
  }

  switch (node.type) {
    case 'Identifier':
      names.add(node.name)
      break
    case 'ObjectPattern':
      for (const property of node.properties) collectBoundNames(property, names)
      break
    case 'ArrayPattern':
      for (const element of node.elements) collectBoundNames(element, names)
      break
    case 'Property':
      collectBoundNames(node.value, names)
      break
    case 'RestElement':
      collectBoundNames(node.argument, names)
      break
    case 'AssignmentPattern':
      collectBoundNames(node.left, names)
      break
    default:
      break
  }
}

export const propsDestructuringNewline: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require React components to accept a single props parameter and destructure it on its own line in the body, rather than destructuring inline in the parameter list.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#props-destructuring-newline',
    },
    fixable: 'code',
    schema: [],
    messages: {
      destructureOnNewLine:
        'Accept a single `props` parameter and destructure it on its own line in the component body instead of destructuring in the parameter list.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode

    const check = (node: ComponentFunction): void => {
      const firstParam = node.params[0]

      if (!firstParam || firstParam.type !== 'ObjectPattern') {
        return
      }

      if (!isComponent(node)) {
        return
      }

      // The fix renames the parameter to `props` and re-destructures it in the body
      // (`const <pattern> = props`). If the pattern already binds `props` (e.g. a
      // `...props` rest, a `{ props }` shorthand, or a `{ data: props }` rename), that
      // body binding collides with the new parameter and yields an invalid "Duplicate
      // declaration props". No safe rename keeps the `props` name the rule mandates —
      // and an ESLint fixer cannot scope-rename the downstream `props.*` usages a rename
      // would require — so these patterns are still reported (the inline destructuring is
      // a violation regardless) but WITHOUT an autofix; the developer resolves them by hand.
      const boundNames = new Set<string>()

      collectBoundNames(firstParam, boundNames)

      const bindsProps = boundNames.has('props')

      const objectPattern = firstParam as AnnotatedPattern

      context.report({
        node: firstParam,
        messageId: 'destructureOnNewLine',
        fix: bindsProps
          ? undefined
          : (fixer) => {
              const text = sourceCode.getText()
              const annotation = objectPattern.typeAnnotation

              const patternStart = objectPattern.range![0]
              const patternEnd = annotation ? annotation.range![0] : objectPattern.range![1]
              const fullEnd = annotation ? annotation.range![1] : objectPattern.range![1]

              const patternText = text.slice(patternStart, patternEnd).trim()
              const annotationText = annotation ? sourceCode.getText(annotation) : ''

              const fixes = [fixer.replaceTextRange([patternStart, fullEnd], `props${annotationText}`)]

              const destructureStatement = `const ${patternText} = props`

              // Indentation of the line the component is declared on, used as the base for inserted code.
              const lines = sourceCode.getLines()
              const declarationLine = lines[node.loc!.start.line - 1] ?? ''
              const baseIndent = declarationLine.slice(0, declarationLine.length - declarationLine.trimStart().length)
              const innerIndent = `${baseIndent}  `

              if (node.body.type === 'BlockStatement') {
                const [firstStatement] = node.body.body

                if (firstStatement) {
                  const indent = ' '.repeat(firstStatement.loc!.start.column)

                  fixes.push(fixer.insertTextBefore(firstStatement, `${destructureStatement}\n\n${indent}`))
                } else {
                  const openBrace = sourceCode.getFirstToken(node.body)!

                  fixes.push(fixer.insertTextAfter(openBrace, `\n${innerIndent}${destructureStatement}\n${baseIndent}`))
                }

                return fixes
              }

              // Expression-bodied arrow (implicit return) — wrap it in a block.
              const bodyText = sourceCode.getText(node.body)

              fixes.push(
                fixer.replaceText(
                  node.body,
                  `{\n${innerIndent}${destructureStatement}\n\n${innerIndent}return ${bodyText}\n${baseIndent}}`,
                ),
              )

              return fixes
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
