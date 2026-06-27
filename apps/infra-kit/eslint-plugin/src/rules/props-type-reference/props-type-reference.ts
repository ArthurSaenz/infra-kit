import type { Rule } from 'eslint'

import type { ComponentFunction } from '../../utils/component'
import { getAnnotatedParam, getComponentName, isComponent } from '../../utils/component'
import { matchesAnyGlob } from '../../utils/path-match'

interface Options {
  paths?: string[]
  ignore?: string[]
}

// TS-only nodes are not modelled by estree, so we view them through a minimal two-level
// structural interface: the `TSTypeAnnotation` wrapper a parser attaches to a parameter, and
// its inner type node. An inline object type is `TSTypeLiteral`; a named type is `TSTypeReference`.
interface AnnotatedNode {
  typeAnnotation?: {
    typeAnnotation?: { type?: string }
  }
}

const INLINE_OBJECT_TYPE = 'TSTypeLiteral'

export const propsTypeReference: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        "Require a React component's props parameter to use a named type (e.g. `ButtonProps`) instead of an inline object type literal.",
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#props-type-reference',
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
      useNamedPropsType:
        "Use a named props type (e.g. `{{name}}Props`) instead of an inline object type for this component's props.",
      useNamedPropsTypeAnonymous: "Use a named props type instead of an inline object type for this component's props.",
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
      const firstParam = node.params[0]

      if (!firstParam || !isComponent(node)) {
        return
      }

      const annotatedParam = getAnnotatedParam(firstParam)
      const innerType = (annotatedParam as AnnotatedNode).typeAnnotation?.typeAnnotation?.type

      if (innerType !== INLINE_OBJECT_TYPE) {
        return
      }

      const name = getComponentName(node)

      context.report(
        name === null
          ? { node: annotatedParam, messageId: 'useNamedPropsTypeAnonymous' }
          : { node: annotatedParam, messageId: 'useNamedPropsType', data: { name } },
      )
    }

    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
    }
  },
}
