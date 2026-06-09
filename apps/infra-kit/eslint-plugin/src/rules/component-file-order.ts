import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { getComponentFunction, isComponent } from '../utils/component'
import { matchesAnyGlob } from '../utils/path-match'

interface Options {
  paths?: string[]
  ignore?: string[]
}

// TS-only nodes are not modelled by estree; access their identifier structurally.
interface NamedDeclaration {
  type: string
  id?: { name?: string } | null
}

const PROPS_SUFFIX = 'Props'

/** Unwrap an `export ...` statement to the declaration it wraps (or the statement itself). */
const unwrapExport = (statement: ESTree.Statement | ESTree.ModuleDeclaration): ESTree.Node | null => {
  if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') {
    return (statement.declaration as ESTree.Node | null) ?? null
  }

  return statement
}

/** Whether a declaration is a props interface/type alias (`SomethingProps`). */
const isPropsTypeDeclaration = (node: ESTree.Node | null): boolean => {
  if (!node) {
    return false
  }

  const named = node as NamedDeclaration

  if (named.type !== 'TSInterfaceDeclaration' && named.type !== 'TSTypeAliasDeclaration') {
    return false
  }

  return named.id?.name?.endsWith(PROPS_SUFFIX) ?? false
}

/** Whether a top-level declaration declares a React component. */
const declaresComponent = (node: ESTree.Node | null): boolean => {
  if (!node) {
    return false
  }

  if (node.type === 'FunctionDeclaration') {
    return isComponent(node)
  }

  if (node.type === 'VariableDeclaration') {
    return node.declarations.some((declaration) => {
      const fn = getComponentFunction(declaration.init)

      return fn ? isComponent(fn) : false
    })
  }

  const fn = getComponentFunction(node)

  return fn ? isComponent(fn) : false
}

export const componentFileOrder: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce a strict top-level order in React component files: imports first, then the component props interface/type, then the component declaration.',
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
      importsFirst: 'Imports must come before the component interface and declaration.',
      interfaceBeforeComponent: 'The component props interface must be declared before the component.',
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
        const body = program.body

        const importIndices: number[] = []
        const propsIndices: number[] = []
        let componentIndex = -1

        body.forEach((statement, index) => {
          if (statement.type === 'ImportDeclaration') {
            importIndices.push(index)

            return
          }

          const declaration = unwrapExport(statement)

          if (isPropsTypeDeclaration(declaration)) {
            propsIndices.push(index)
          }

          if (componentIndex === -1 && declaresComponent(declaration)) {
            componentIndex = index
          }
        })

        // The rule only governs files that actually contain a component.
        if (componentIndex === -1) {
          return
        }

        // Imports must precede the first props interface and the component.
        const importBoundary = Math.min(componentIndex, ...propsIndices)

        for (const importIndex of importIndices) {
          if (importIndex > importBoundary) {
            context.report({ node: body[importIndex]!, messageId: 'importsFirst' })
          }
        }

        // The props interface/type must precede the component declaration.
        for (const propsIndex of propsIndices) {
          if (propsIndex > componentIndex) {
            context.report({ node: body[propsIndex]!, messageId: 'interfaceBeforeComponent' })
          }
        }
      },
    }
  },
}

export default componentFileOrder
