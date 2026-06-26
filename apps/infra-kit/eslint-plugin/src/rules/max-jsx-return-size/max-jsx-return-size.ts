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

// estree does not model JSX, so child traversal is driven by the parser-provided
// `visitorKeys` (real child keys only — excludes `parent`/`loc`/`range`), falling
// back to `Object.keys`; `parent` is skipped explicitly to guard recursion.
const childNodes = (node: ESTree.Node, visitorKeys: VisitorKeys): ESTree.Node[] => {
  const children: ESTree.Node[] = []
  const keys = visitorKeys[node.type as string] ?? Object.keys(node)

  for (const key of keys) {
    if (key === 'parent') {
      continue
    }

    const value = (node as unknown as Record<string, unknown>)[key]

    if (Array.isArray(value)) {
      children.push(...value.filter(isNode))
    } else if (isNode(value)) {
      children.push(value)
    }
  }

  return children
}

/**
 * Count the `JSXElement` nodes in an expression subtree. `JSXElement` counts 1;
 * `JSXFragment` counts 0 (a no-op wrapper) but still recurses. The walk descends
 * into nested function scopes, so inline-callback JSX (`.map(() => <li/>)`) is
 * counted once within its enclosing return — the counterpart to
 * `collectOwnReturnArguments`, which skips those scopes.
 */
const countJsxElements = (node: ESTree.Node, visitorKeys: VisitorKeys): number => {
  const self = (node.type as string) === 'JSXElement' ? 1 : 0

  return childNodes(node, visitorKeys).reduce((total, child) => {
    return total + countJsxElements(child, visitorKeys)
  }, self)
}

// Structural views over JSX nodes estree does not type. A JSX element's tag name
// is on `openingElement.name`, which is an identifier (`name` is a string), a
// member expression (`Foo.Bar`), or a namespaced name (`svg:rect`) — so the
// child slots are read as `unknown` and narrowed per node type.
interface JsxNameNode {
  type?: string
  name?: unknown
  object?: unknown
  property?: unknown
  namespace?: unknown
}

interface JsxElementNode {
  openingElement?: { name?: unknown }
  loc?: { start: { line: number } }
}

const jsxNameToString = (node: unknown): string => {
  const name = node as JsxNameNode | null | undefined

  switch (name?.type) {
    case 'JSXIdentifier':
      return typeof name.name === 'string' ? name.name : 'element'
    case 'JSXMemberExpression':
      return `${jsxNameToString(name.object)}.${jsxNameToString(name.property)}`
    case 'JSXNamespacedName':
      return `${jsxNameToString(name.namespace)}:${jsxNameToString(name.name)}`
    default:
      return 'element'
  }
}

// The JSXElements directly under `root` (descending only through non-element
// wrappers like fragments, expression containers, conditionals, and `.map`
// callbacks). A parent always out-counts its children, so the largest of these
// is the single biggest block a reader could lift out of the return.
const topLevelElements = (root: ESTree.Node, visitorKeys: VisitorKeys): ESTree.Node[] => {
  const elements: ESTree.Node[] = []

  const walk = (node: ESTree.Node, isRoot: boolean): void => {
    if (!isRoot && (node.type as string) === 'JSXElement') {
      elements.push(node)

      return
    }

    for (const child of childNodes(node, visitorKeys)) {
      walk(child, false)
    }
  }

  walk(root, true)

  return elements
}

interface LargestBlock {
  name: string
  line: number
  count: number
}

/** The biggest extractable JSX block inside a return, for an actionable message. */
const largestBlock = (root: ESTree.Node, visitorKeys: VisitorKeys): LargestBlock | null => {
  let best: { node: ESTree.Node; count: number } | null = null

  for (const element of topLevelElements(root, visitorKeys)) {
    const count = countJsxElements(element, visitorKeys)

    if (!best || count > best.count) {
      best = { node: element, count }
    }
  }

  if (!best) {
    return null
  }

  const element = best.node as unknown as JsxElementNode

  return { name: jsxNameToString(element.openingElement?.name), line: element.loc?.start.line ?? 0, count: best.count }
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
      // Points at the single biggest block so a human or AI fix loop knows
      // exactly what to lift out.
      tooManyElements:
        '{{name}} renders {{count}} JSX elements in one return (max {{max}}). Extract the largest block — <{{largest}}> at line {{line}} ({{largestCount}} elements) — into a variable or a sub-component.',
      // Fallback when no single block dominates (e.g. many flat siblings): there is
      // nothing meaningful to point at, so advise splitting.
      tooManyElementsFlat:
        '{{name}} renders {{count}} JSX elements in one return (max {{max}}). Split it into smaller sub-components or extract groups of elements into variables.',
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

        if (count <= max) {
          continue
        }

        const largest = largestBlock(argument, visitorKeys)

        if (largest && largest.count >= 2) {
          context.report({
            node: argument,
            messageId: 'tooManyElements',
            data: { count, max, name, largest: largest.name, line: largest.line, largestCount: largest.count },
          })
        } else {
          context.report({ node: argument, messageId: 'tooManyElementsFlat', data: { count, max, name } })
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
