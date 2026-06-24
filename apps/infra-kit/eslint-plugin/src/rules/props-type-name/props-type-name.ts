import type { Rule } from 'eslint'

import type { ComponentFunction } from '../../utils/component'
import { getAnnotatedParam, getComponentName, getPropsTypeNameFromFunction, isComponent } from '../../utils/component'
import { matchesAnyGlob } from '../../utils/path-match'

interface Options {
  paths?: string[]
  ignore?: string[]
}

const PROPS_SUFFIX = 'Props'

export const propsTypeName: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        "Require a React component's props type to be named `<ComponentName>Props` (e.g. `ButtonProps` for `Button`).",
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
              'Optional glob patterns. The rule is skipped for files whose path matches one of them, even if it also matches `paths`.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      propsTypeNameMismatch: "A component's props type must be named `{{expected}}`, but it is named `{{actual}}`.",
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

    const check = (node: ComponentFunction): void => {
      if (!isComponent(node)) {
        return
      }

      // An anonymous component (e.g. `export default () => ...`) has no name to derive the
      // expected props type name from, so the convention cannot be checked.
      const componentName = getComponentName(node)

      if (componentName === null) {
        return
      }

      // Only a simple named type reference is checked. An inline object type is the
      // `props-type-reference` rule's concern; qualified names and generics are out of scope and
      // resolve to null. A component with no typed props parameter is likewise not constrained.
      const actual = getPropsTypeNameFromFunction(node)

      if (actual === null) {
        return
      }

      const expected = `${componentName}${PROPS_SUFFIX}`

      if (actual === expected) {
        return
      }

      // `getPropsTypeNameFromFunction` only returns non-null when the first parameter carries a
      // named type reference, so an annotated parameter is guaranteed to exist here.
      context.report({
        node: getAnnotatedParam(node.params[0]!),
        messageId: 'propsTypeNameMismatch',
        data: { expected, actual },
      })
    }

    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
    }
  },
}
