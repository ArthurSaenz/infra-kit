import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { getComponentFunction, getComponentName, isComponent, unwrapExport } from '../../utils/component'
import type { ComponentFunction } from '../../utils/component'
import { matchesAnyGlob } from '../../utils/path-match'

interface Options {
  paths?: string[]
  ignore?: string[]
}

// Fallback used when a component is anonymous (e.g. `export default memo(function () { ... })`),
// since `getComponentName` returns null rather than a placeholder in that case.
const ANONYMOUS_NAME = 'component'

type MessageId = 'functionDeclaration' | 'functionExpression'

interface Violation {
  node: ESTree.Node
  messageId: MessageId
  name: string
}

const reportName = (fn: ComponentFunction): string => {
  return getComponentName(fn) ?? ANONYMOUS_NAME
}

/**
 * Violation for a single non-`VariableDeclaration` top-level declaration:
 *  - a `function Foo() {}` component declaration (incl. exported/default/anonymous), or
 *  - an expression that resolves to a function-expression component
 *    (e.g. `export default memo(function () { ... })`).
 */
const nonVariableViolation = (declaration: ESTree.Node): Violation | null => {
  if (declaration.type === 'FunctionDeclaration') {
    return isComponent(declaration)
      ? { node: declaration, messageId: 'functionDeclaration', name: reportName(declaration) }
      : null
  }

  const fn = getComponentFunction(declaration)

  return fn?.type === 'FunctionExpression' && isComponent(fn)
    ? { node: fn, messageId: 'functionExpression', name: reportName(fn) }
    : null
}

/** Function-expression component violations across every declarator in a `const`/`let`/`var`. */
const variableViolations = (declaration: ESTree.VariableDeclaration): Violation[] => {
  const violations: Violation[] = []

  for (const declarator of declaration.declarations) {
    const fn = getComponentFunction(declarator.init)

    if (fn?.type === 'FunctionExpression' && isComponent(fn)) {
      violations.push({ node: declarator, messageId: 'functionExpression', name: reportName(fn) })
    }
  }

  return violations
}

/** Every non-arrow component declared at the top level of the program body. */
const collectViolations = (body: Array<ESTree.Statement | ESTree.ModuleDeclaration>): Violation[] => {
  const violations: Violation[] = []

  for (const statement of body) {
    const declaration = unwrapExport(statement)

    if (!declaration) {
      continue
    }

    if (declaration.type === 'VariableDeclaration') {
      violations.push(...variableViolations(declaration))

      continue
    }

    const violation = nonVariableViolation(declaration)

    if (violation) {
      violations.push(violation)
    }
  }

  return violations
}

export const componentArrowFunction: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce that React components are declared as arrow functions, not `function` declarations or function expressions.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin',
    },
    schema: [
      {
        type: 'object',
        properties: {
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
              'Optional glob patterns. The rule is skipped for files whose path matches one of them, even if it also matches `paths`. Use this to exclude pages and routes (e.g. `**/pages/**`, `**/routes/**`).',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      functionDeclaration:
        'React components must be arrow functions; convert the `function {{name}}` declaration to `const {{name}} = () => { … }`.',
      functionExpression:
        'React components must be arrow functions; replace the `function` expression for `{{name}}` with an arrow function.',
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

    return {
      Program(program) {
        for (const { node, messageId, name } of collectViolations(program.body)) {
          context.report({ node, messageId, data: { name } })
        }
      },
    }
  },
}
