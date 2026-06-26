import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { getComponentFunction, getComponentName, isComponent, unwrapExport } from '../../utils/component'
import type { ComponentFunction } from '../../utils/component'
import { matchesAnyGlob } from '../../utils/path-match'

interface Options {
  maxComponents?: number
  paths?: string[]
  ignore?: string[]
}

// Default ceiling on component declarations in a single file. Tunable via the
// `maxComponents` option; the value is a convention nudge ("split this file"),
// not a hard truth.
const DEFAULT_MAX_COMPONENTS = 4

// Fallback used when the offending component is anonymous (e.g.
// `export default () => <div />`), since `getComponentName` returns null rather
// than a placeholder in that case.
const ANONYMOUS_NAME = 'component'

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
 * `max-jsx-return-size` and `component-arrow-function`). Multi-declarator
 * declarations (`const A = …, B = …`) count each component separately;
 * re-exports (`export { X } from './x'`) declare nothing and are not counted.
 * Nested/in-render components are deliberately out of scope — that is a
 * different concern (component identity/perf), not file organisation.
 *
 * Returns the component *functions* (not just a count) so a future export-aware
 * variant — count only non-exported helpers — is an additive change, not a
 * rewrite.
 */
const collectComponents = (body: Array<ESTree.Statement | ESTree.ModuleDeclaration>): ComponentFunction[] => {
  return body.flatMap((statement) => {
    const declaration = unwrapExport(statement)

    return declaration ? componentFunctionsIn(declaration) : []
  })
}

export const maxComponentsPerFile: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Limit the number of React components declared in a single file; move extra components into their own files.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin',
    },
    schema: [
      {
        type: 'object',
        properties: {
          maxComponents: {
            type: 'integer',
            minimum: 1,
            description: 'Maximum number of component declarations a single file may contain before the rule reports.',
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
      // File-scoped problem → reported once, anchored to the first component over
      // the limit so a human or AI fix loop has a concrete node to move out.
      tooManyComponents:
        'This file declares {{count}} components (max {{max}}); move components such as {{name}} into separate files.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const max = options.maxComponents ?? DEFAULT_MAX_COMPONENTS
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
        const components = collectComponents(program.body)

        if (components.length <= max) {
          return
        }

        // The first component beyond the limit: a real, moveable node, and the
        // single report keeps one file-scoped problem from emitting N squiggles
        // (there is no autofix to justify multiplicity). `length > max` guarantees
        // this index exists; the guard satisfies `noUncheckedIndexedAccess`.
        const offender = components[max]

        if (!offender) {
          return
        }

        const name = getComponentName(offender) ?? ANONYMOUS_NAME

        context.report({
          node: offender,
          messageId: 'tooManyComponents',
          data: { count: components.length, max, name },
        })
      },
    }
  },
}
