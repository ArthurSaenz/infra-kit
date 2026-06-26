import type { Rule, SourceCode } from 'eslint'
import type * as ESTree from 'estree'

import {
  collectOwnReturnArguments,
  getComponentFunction,
  getComponentName,
  isComponent,
  unwrapExport,
} from '../../utils/component'
import type { ComponentFunction } from '../../utils/component'
import { matchesAnyGlob } from '../../utils/path-match'

interface Options {
  maxElements?: number
  paths?: string[]
  ignore?: string[]
}

// Default ceiling on JSX elements rendered by a single return. Tunable via the
// `maxElements` option; the value is a starting estimate, not a hard truth.
const DEFAULT_MAX_ELEMENTS = 20

// Fallback used when a component is anonymous (e.g. `export default () => <div />`),
// since `getComponentName` returns null rather than a placeholder in that case.
const ANONYMOUS_NAME = 'component'

type VisitorKeys = SourceCode.VisitorKeys

const isNode = (value: unknown): value is ESTree.Node => {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

/**
 * Count the `JSXElement` nodes in an expression subtree. estree does not model
 * JSX, so traversal is driven by the parser-provided `visitorKeys` (real child
 * keys only — excludes `parent`/`loc`/`range`), falling back to `Object.keys`;
 * `parent` is skipped explicitly to guard against infinite recursion.
 *
 * `JSXElement` counts 1; `JSXFragment` counts 0 (a no-op wrapper) but still
 * recurses. The walk descends into nested function scopes, so inline-callback
 * JSX (`.map(() => <li/>)`) is counted once within its enclosing return — the
 * counterpart to `collectOwnReturnArguments`, which skips those scopes.
 */
const countJsxElements = (node: ESTree.Node, visitorKeys: VisitorKeys): number => {
  const type = node.type as string

  let total = type === 'JSXElement' ? 1 : 0

  const keys = visitorKeys[type] ?? Object.keys(node)

  for (const key of keys) {
    if (key === 'parent') {
      continue
    }

    const value = (node as unknown as Record<string, unknown>)[key]

    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          total += countJsxElements(item, visitorKeys)
        }
      }
    } else if (isNode(value)) {
      total += countJsxElements(value, visitorKeys)
    }
  }

  return total
}

/** The component function(s) declared by a single top-level declaration. */
const componentFunctionsIn = (declaration: ESTree.Node): ComponentFunction[] => {
  if (declaration.type === 'FunctionDeclaration') {
    return isComponent(declaration) ? [declaration] : []
  }

  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations
      .map((declarator) => {
        return getComponentFunction(declarator.init)
      })
      .filter((fn): fn is ComponentFunction => {
        return fn !== null && isComponent(fn)
      })
  }

  // e.g. `export default memo(() => …)`.
  const fn = getComponentFunction(declaration)

  return fn && isComponent(fn) ? [fn] : []
}

/**
 * Every component declared at the TOP LEVEL of the program body (mirrors
 * `component-arrow-function`). Anonymous inline callbacks are never collected, so
 * a single oversized return can never be reported twice.
 */
const collectComponents = (body: Array<ESTree.Statement | ESTree.ModuleDeclaration>): ComponentFunction[] => {
  return body.flatMap((statement) => {
    const declaration = unwrapExport(statement)

    return declaration ? componentFunctionsIn(declaration) : []
  })
}

export const maxJsxReturnSize: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Warn when a component return renders too many JSX elements; extract parts into variables or sub-components.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin',
    },
    schema: [
      {
        type: 'object',
        properties: {
          maxElements: {
            type: 'integer',
            minimum: 1,
            description: 'Maximum number of JSX elements a single return may render before the rule reports.',
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
      tooManyElements:
        'This return renders {{count}} JSX elements (max {{max}}). Extract part of {{name}} into a variable or a sub-component.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const max = options.maxElements ?? DEFAULT_MAX_ELEMENTS
    const paths = options.paths ?? []
    const ignore = options.ignore ?? []

    // `ignore` takes precedence: skip excluded files even when they also match `paths`.
    if (ignore.length > 0 && matchesAnyGlob(context.filename, ignore)) {
      return {}
    }

    if (paths.length > 0 && !matchesAnyGlob(context.filename, paths)) {
      return {}
    }

    const visitorKeys = context.sourceCode.visitorKeys

    // Measure one declared component: count each of its own return arguments
    // (nested scopes skipped by `collectOwnReturnArguments`; arrow implicit body
    // included) and report once per return that exceeds `max`.
    const checkComponent = (fn: ComponentFunction): void => {
      const name = getComponentName(fn) ?? ANONYMOUS_NAME

      for (const argument of collectOwnReturnArguments(fn)) {
        const count = countJsxElements(argument, visitorKeys)

        if (count > max) {
          context.report({ node: argument, messageId: 'tooManyElements', data: { count, max, name } })
        }
      }
    }

    return {
      Program(program) {
        collectComponents(program.body).forEach(checkComponent)
      },
    }
  },
}
