import type { Rule, SourceCode } from 'eslint'
import type * as ESTree from 'estree'

import type { ComponentFunction } from '../../utils/component'
import { collectOwnReturnArguments, getAnnotatedParam } from '../../utils/component'
import { DUMB_COMPONENT_PATHS, isInScope, isStoryOrTestFile, isUiPackageFile } from '../../utils/component-file-scope'
import type { ExportedComponent } from '../../utils/exported-components'
import { collectExportedComponents } from '../../utils/exported-components'

interface Options {
  paths?: string[]
  ignore?: string[]
}

// TS and JSX nodes are not modelled by estree; these are the minimal structural views the rule reads.
interface TsMember {
  type: string
  computed?: boolean
  key?: { type: string; name?: string; value?: unknown }
  range: [number, number]
  loc: ESTree.SourceLocation
}

interface TsType {
  type: string
  members?: TsMember[]
  types?: TsType[]
  typeName?: { type: string; name?: string }
  typeArguments?: unknown
  range: [number, number]
  loc: ESTree.SourceLocation
}

interface TsDeclaration {
  type: string
  id?: { name?: string }
  body?: { body: TsMember[]; range: [number, number]; loc: ESTree.SourceLocation }
  extends?: unknown[]
  typeAnnotation?: TsType
}

interface JsxNode {
  type: string
  name?: JsxNode & { name?: string | JsxNode }
  property?: JsxNode & { name?: string }
  openingElement?: JsxNode
  attributes?: JsxNode[]
  value?: { type: string; expression?: ESTree.Node } | null
}

/** Where `className?: string` can be appended: the member list and the braces around it. */
interface MemberContainer {
  members: TsMember[]
  body: { range: [number, number]; loc: ESTree.SourceLocation }
}

/** What is known about a props type: null when it cannot be resolved in this file. */
type PropsShape = { hasClassName: boolean; container: MemberContainer | null } | null

/** How the root element can reach the prop: the `className` binding or `<object>.className`. */
type ClassNameBinding = { kind: 'identifier'; name: string } | { kind: 'member'; object: string }

const MAX_ALIAS_DEPTH = 5

const isClassNameMember = (member: TsMember): boolean => {
  if (member.type !== 'TSPropertySignature' || member.computed) {
    return false
  }

  return member.key?.name === 'className' || member.key?.value === 'className'
}

const findTypeDeclaration = (program: ESTree.Program, name: string): TsDeclaration | null => {
  for (const statement of program.body) {
    const node = (
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    ) as TsDeclaration | null

    if (
      (node?.type === 'TSInterfaceDeclaration' || node?.type === 'TSTypeAliasDeclaration') &&
      node.id?.name === name
    ) {
      return node
    }
  }

  return null
}

const fromMembers = (members: TsMember[], body: MemberContainer['body']): PropsShape => {
  return { hasClassName: members.some(isClassNameMember), container: { members, body } }
}

const fromIntersection = (shapes: PropsShape[]): PropsShape => {
  if (
    shapes.some((shape) => {
      return shape?.hasClassName
    })
  ) {
    return { hasClassName: true, container: null }
  }

  // An unresolved part (an imported base type) may well declare `className`.
  if (shapes.includes(null)) {
    return null
  }

  return {
    hasClassName: false,
    container:
      shapes.findLast((shape) => {
        return shape?.container
      })?.container ?? null,
  }
}

const resolveShape = (program: ESTree.Program, type: TsType | undefined, depth: number): PropsShape => {
  if (!type || depth > MAX_ALIAS_DEPTH) {
    return null
  }

  if (type.type === 'TSTypeLiteral') {
    return fromMembers(type.members ?? [], type)
  }

  if (type.type === 'TSIntersectionType') {
    return fromIntersection(
      (type.types ?? []).map((part) => {
        return resolveShape(program, part, depth + 1)
      }),
    )
  }

  if (type.type !== 'TSTypeReference' || type.typeName?.type !== 'Identifier' || type.typeArguments) {
    return null
  }

  const declaration = findTypeDeclaration(program, type.typeName.name!)

  if (declaration?.type === 'TSTypeAliasDeclaration') {
    return resolveShape(program, declaration.typeAnnotation, depth + 1)
  }

  if (!declaration?.body) {
    return null
  }

  const shape = fromMembers(declaration.body.body, declaration.body)

  // An inherited `className` is invisible here; only an interface with no `extends` is conclusive.
  return shape?.hasClassName || !declaration.extends?.length ? shape : null
}

const bindingFromObjectPattern = (pattern: ESTree.ObjectPattern): ClassNameBinding | null => {
  const destructured = pattern.properties.find((property) => {
    return (
      property.type === 'Property' &&
      !property.computed &&
      property.key.type === 'Identifier' &&
      property.key.name === 'className'
    )
  }) as ESTree.AssignmentProperty | undefined

  if (destructured) {
    const value = destructured.value.type === 'AssignmentPattern' ? destructured.value.left : destructured.value

    return value.type === 'Identifier' ? { kind: 'identifier', name: value.name } : null
  }

  const rest = pattern.properties.find((property) => {
    return property.type === 'RestElement'
  })

  return rest?.argument.type === 'Identifier' ? { kind: 'member', object: rest.argument.name } : null
}

/** `const { className } = props` statements at the top of the component body. */
const bindingsFromBody = (fn: ComponentFunction, propsName: string): ClassNameBinding[] => {
  const statements = fn.body.type === 'BlockStatement' ? fn.body.body : []

  return statements.flatMap((statement) => {
    if (statement.type !== 'VariableDeclaration') {
      return []
    }

    return statement.declarations.flatMap((declarator) => {
      const isPropsDestructure =
        declarator.id.type === 'ObjectPattern' &&
        declarator.init?.type === 'Identifier' &&
        declarator.init.name === propsName

      const binding = isPropsDestructure ? bindingFromObjectPattern(declarator.id as ESTree.ObjectPattern) : null

      return binding ? [binding] : []
    })
  })
}

const getClassNameBindings = (fn: ComponentFunction): ClassNameBinding[] => {
  const param = fn.params[0]
  const pattern = param ? getAnnotatedParam(param) : null

  if (pattern?.type === 'Identifier') {
    return [{ kind: 'member', object: pattern.name }, ...bindingsFromBody(fn, pattern.name)]
  }

  const binding = pattern?.type === 'ObjectPattern' ? bindingFromObjectPattern(pattern) : null

  return binding ? [binding] : []
}

const matchesBinding = (node: ESTree.Node, binding: ClassNameBinding): boolean => {
  if (binding.kind === 'identifier') {
    return node.type === 'Identifier' && node.name === binding.name
  }

  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === binding.object &&
    node.property.type === 'Identifier' &&
    node.property.name === 'className'
  )
}

const referencesBinding = (
  node: ESTree.Node,
  binding: ClassNameBinding,
  visitorKeys: SourceCode.VisitorKeys,
): boolean => {
  if (matchesBinding(node, binding)) {
    return true
  }

  // A non-computed property name (`styles.className`, `{ className: x }`) is a label, not the binding.
  const label = node.type === 'MemberExpression' ? 'property' : 'key'

  const keys = (visitorKeys[node.type] ?? []).filter((key) => {
    return !(key === label && 'computed' in node && !node.computed)
  })

  return keys.some((key) => {
    const child = (node as unknown as Record<string, unknown>)[key]
    const children = (Array.isArray(child) ? child : [child]) as Array<ESTree.Node | null>

    return children.some((item) => {
      return item !== null && typeof item?.type === 'string' && referencesBinding(item, binding, visitorKeys)
    })
  })
}

const isFragment = (element: JsxNode): boolean => {
  const name = element.openingElement?.name

  if (name?.type === 'JSXIdentifier') {
    return name.name === 'Fragment'
  }

  return name?.type === 'JSXMemberExpression' && name.property?.name === 'Fragment'
}

/** The single JSX element a component returns, or null when the root is not one plain element. */
const getRootElement = (fn: ComponentFunction): JsxNode | null => {
  const returns = collectOwnReturnArguments(fn)
  const root = returns.length === 1 ? (returns[0] as unknown as JsxNode) : null

  return root?.type === 'JSXElement' && !isFragment(root) ? root : null
}

const buildMemberFix = (sourceCode: SourceCode, container: MemberContainer): Rule.ReportFixer => {
  return (fixer) => {
    const last = container.members.at(-1)

    if (!last) {
      return fixer.replaceTextRange(container.body.range, '{ className?: string }')
    }

    const separator = /[;,]$/.exec(sourceCode.text.slice(...last.range))?.[0] ?? ''

    if (container.body.loc.start.line === container.body.loc.end.line) {
      return fixer.insertTextAfterRange(
        last.range,
        separator ? ` className?: string${separator}` : '; className?: string',
      )
    }

    const indent = /^\s*/.exec(sourceCode.lines[last.loc.start.line - 1]!)![0]

    return fixer.insertTextAfterRange(last.range, `\n${indent}className?: string${separator}`)
  }
}

export const componentClassname: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: {
      description:
        'Require a dumb component to declare a `className` prop and merge it into its root element (`className={cn(..., className)}`).',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#component-classname',
    },
    schema: [
      {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: `Glob patterns of the files to check. Replaces the default (${DUMB_COMPONENT_PATHS.join(', ')}).`,
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Glob patterns of files to skip (e.g. svg sprites, icons), even if they also match `paths`. Stories and tests are always skipped.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingClassNameProp:
        '`{{name}}` must accept a `className` prop: declare `className?: string` on its props type so callers can position it.',
      rootMissingClassName:
        "The root element of `{{name}}` must merge the `className` prop, e.g. `className={cn('…', className)}`.",
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')

    if (
      isStoryOrTestFile(filename) ||
      !isInScope(filename, options.paths ?? DUMB_COMPONENT_PATHS, options.ignore ?? []) ||
      !isUiPackageFile(filename)
    ) {
      return {}
    }

    const { sourceCode } = context

    const checkProps = (program: ESTree.Program, component: ExportedComponent, name: string): void => {
      const param = component.fn.params[0]

      if (!param) {
        context.report({ node: component.id ?? component.fn, messageId: 'missingClassNameProp', data: { name } })

        return
      }

      const annotation = (getAnnotatedParam(param) as { typeAnnotation?: { typeAnnotation?: TsType } }).typeAnnotation
        ?.typeAnnotation

      const shape = annotation ? resolveShape(program, annotation, 0) : null

      if (shape && !shape.hasClassName) {
        context.report({
          node: param,
          messageId: 'missingClassNameProp',
          data: { name },
          fix: shape.container ? buildMemberFix(sourceCode, shape.container) : null,
        })
      }
    }

    const checkRoot = (component: ExportedComponent, name: string): void => {
      const root = getRootElement(component.fn)
      const attributes = root?.openingElement?.attributes ?? []

      // A spread (`{...rest}`) may carry `className` through; it cannot be told apart statically.
      if (
        !root ||
        attributes.some((attribute) => {
          return attribute.type === 'JSXSpreadAttribute'
        })
      ) {
        return
      }

      const attribute = attributes.find((candidate) => {
        return candidate.type === 'JSXAttribute' && candidate.name?.name === 'className'
      })

      const bindings = getClassNameBindings(component.fn)

      const expression =
        attribute?.value?.type === 'JSXExpressionContainer' ? (attribute.value.expression ?? null) : null

      const merged =
        expression !== null &&
        bindings.some((binding) => {
          return referencesBinding(expression, binding, sourceCode.visitorKeys)
        })

      if (!merged) {
        context.report({
          node: (attribute ?? root.openingElement!.name!) as unknown as ESTree.Node,
          messageId: 'rootMissingClassName',
          data: { name },
        })
      }
    }

    return {
      Program(program) {
        for (const component of collectExportedComponents(program)) {
          const name = component.name ?? 'this component'

          checkProps(program, component, name)
          checkRoot(component, name)
        }
      },
    }
  },
}
