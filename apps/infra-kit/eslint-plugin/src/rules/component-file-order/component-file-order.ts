import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import {
  declaresComponent,
  getComponentPropsTypeName,
  getDeclaredComponentName,
  unwrapExport,
} from '../../utils/component'
import { matchesAnyGlob } from '../../utils/path-match'

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

/**
 * Count the directive prologue — the leading run of string-literal expression statements
 * (`'use client'`, `'use server'`, `'use strict'`) at the top of the file. They are
 * legitimate file-leading content (like imports) and must not count as "stray" before the
 * props interface. Per the ECMAScript spec a directive is only one that *precedes* any other
 * statement, so we stop at the first non-string-literal statement rather than matching any
 * bare string anywhere in the body.
 */
const getDirectivePrologueCount = (body: Array<ESTree.Statement | ESTree.ModuleDeclaration>): number => {
  let count = 0

  for (const statement of body) {
    const isStringExpression =
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'Literal' &&
      typeof statement.expression.value === 'string'

    if (!isStringExpression) {
      break
    }

    count += 1
  }

  return count
}

/**
 * The name of a top-level interface or type-alias declaration, or null when it is neither.
 * Unlike the props lookup, this is name-agnostic: any local type declaration is indexed so a
 * component can be matched against the type it actually references, whatever that type is called.
 */
const getTypeDeclName = (node: ESTree.Node | null): string | null => {
  if (!node) {
    return null
  }

  const named = node as NamedDeclaration

  if (named.type !== 'TSInterfaceDeclaration' && named.type !== 'TSTypeAliasDeclaration') {
    return null
  }

  return named.id?.name ?? null
}

interface ComponentRef {
  index: number
  name: string | null
  // The type name the component uses for its props — resolved from its parameter annotation, or
  // the `<Name>Props` convention when the parameter carries no resolvable named type. Null when
  // neither is available (e.g. an anonymous component with no typed props parameter).
  propsName: string | null
}

interface TopLevel {
  importIndices: number[]
  components: ComponentRef[]
  // First index of each top-level type declaration, keyed by its name.
  declIndexByName: Map<string, number>
  // Local binding names introduced by imports — used to detect a props type that is
  // imported (e.g. `import type { CompProps }`) rather than declared in the file.
  importedNames: Set<string>
}

/** Classify each top-level statement into imports, components, local type declarations, and import bindings. */
const collectTopLevel = (body: Array<ESTree.Statement | ESTree.ModuleDeclaration>): TopLevel => {
  const importIndices: number[] = []
  const components: ComponentRef[] = []
  const declIndexByName = new Map<string, number>()
  const importedNames = new Set<string>()

  body.forEach((statement, index) => {
    if (statement.type === 'ImportDeclaration') {
      importIndices.push(index)

      for (const specifier of statement.specifiers) {
        importedNames.add(specifier.local.name)
      }

      return
    }

    const declaration = unwrapExport(statement)

    const declName = getTypeDeclName(declaration)

    if (declName !== null && !declIndexByName.has(declName)) {
      declIndexByName.set(declName, index)
    }

    if (declaresComponent(declaration)) {
      const name = getDeclaredComponentName(declaration)
      // Prefer the type the component's parameter actually references; fall back to the
      // `<Name>Props` convention only when no named parameter type is resolvable.
      const propsName = getComponentPropsTypeName(declaration) ?? (name === null ? null : `${name}${PROPS_SUFFIX}`)

      components.push({ index, name, propsName })
    }
  })

  return { importIndices, components, declIndexByName, importedNames }
}

/**
 * Whether any top-level statement in the half-open range `[directiveCount, boundary)` is a stray —
 * i.e. not an import and not part of the leading directive prologue. `skipIndex` excludes a single
 * known-good statement (the component itself, when scanning the gap before its props interface).
 */
const hasStrayBefore = (
  body: Array<ESTree.Statement | ESTree.ModuleDeclaration>,
  boundary: number,
  directiveCount: number,
  skipIndex?: number,
): boolean => {
  return body.some((statement, index) => {
    return index < boundary && index >= directiveCount && index !== skipIndex && statement.type !== 'ImportDeclaration'
  })
}

type MessageId =
  | 'importsFirst'
  | 'interfaceImmediatelyBeforeComponent'
  | 'interfaceImmediatelyAfterImports'
  | 'componentImmediatelyAfterImports'

// A pending report, expressed as a body index plus the message to raise against it. `data`
// carries the identifier names interpolated into the message so an AI fix loop reads the
// concrete interface/component to move — omitted for `importsFirst`, which stays generic.
interface Violation {
  index: number
  messageId: MessageId
  data?: Record<string, string>
}

// Fallback when a component is anonymous (e.g. `export default (props: Props) => …`), matching
// the `ANONYMOUS_NAME` convention the sibling rules use for a name-less component.
const ANONYMOUS_COMPONENT = 'component'

/** Imports that sit after the first component (or its props interface) must move up. */
const findImportOrderViolations = (importIndices: number[], importBoundary: number): Violation[] => {
  return importIndices
    .filter((importIndex) => {
      return importIndex > importBoundary
    })
    .map((importIndex) => {
      return { index: importIndex, messageId: 'importsFirst' }
    })
}

/**
 * Each component's props type, when declared locally, must sit immediately before the component.
 * The type is matched by the name the component's parameter actually references, so an interface
 * named anything (`Props`, `UserCardProps`, ...) is judged — not just the `<Name>Props` convention.
 * A type referenced by more than one component is skipped: a single declaration cannot sit
 * immediately before two components, so adjacency is unenforceable and would misfire.
 */
const findAdjacencyViolations = (components: ComponentRef[], declIndexByName: Map<string, number>): Violation[] => {
  const violations: Violation[] = []

  const referenceCount = new Map<string, number>()

  for (const component of components) {
    if (component.propsName !== null) {
      referenceCount.set(component.propsName, (referenceCount.get(component.propsName) ?? 0) + 1)
    }
  }

  for (const component of components) {
    const propsName = component.propsName

    if (propsName === null || (referenceCount.get(propsName) ?? 0) > 1) {
      continue
    }

    const propsIndex = declIndexByName.get(propsName)

    if (propsIndex !== undefined && propsIndex !== component.index - 1) {
      violations.push({
        index: propsIndex,
        messageId: 'interfaceImmediatelyBeforeComponent',
        data: { interface: propsName, component: component.name ?? ANONYMOUS_COMPONENT },
      })
    }
  }

  return violations
}

/**
 * The first component is anchored to the import block: no stray top-level definition may wedge
 * between the imports and the props interface — or, when the props type is *imported* rather than
 * declared in the file, between the imports and the component itself. Only the first component is
 * anchored; later interfaces are governed solely by the adjacency check. Each `every` guard skips
 * when an import sits after its anchor, since that misorder is already reported by `importsFirst`.
 */
const findAnchorViolations = (
  body: Array<ESTree.Statement | ESTree.ModuleDeclaration>,
  directiveCount: number,
  importIndices: number[],
  first: ComponentRef,
  firstPropsName: string | null,
  firstPropsIndex: number | undefined,
  importedNames: Set<string>,
): Violation[] => {
  const violations: Violation[] = []

  const importsBeforeInterface =
    firstPropsIndex !== undefined &&
    importIndices.every((importIndex) => {
      return importIndex < firstPropsIndex
    })

  if (importsBeforeInterface && hasStrayBefore(body, firstPropsIndex!, directiveCount, first.index)) {
    violations.push({
      index: firstPropsIndex!,
      messageId: 'interfaceImmediatelyAfterImports',
      // `firstPropsIndex !== undefined` implies `firstPropsName !== null` (it is derived from it).
      data: { interface: firstPropsName!, component: first.name ?? ANONYMOUS_COMPONENT },
    })
  }

  const firstPropsImported =
    firstPropsIndex === undefined && firstPropsName !== null && importedNames.has(firstPropsName)
  const importsBeforeComponent = importIndices.every((importIndex) => {
    return importIndex < first.index
  })

  if (firstPropsImported && importsBeforeComponent && hasStrayBefore(body, first.index, directiveCount)) {
    violations.push({
      index: first.index,
      messageId: 'componentImmediatelyAfterImports',
      // `firstPropsImported` requires `firstPropsName !== null`.
      data: { interface: firstPropsName!, component: first.name ?? ANONYMOUS_COMPONENT },
    })
  }

  return violations
}

export const componentFileOrder: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce a strict top-level order in React component files: imports first, then — for each component — its props interface/type declared immediately before the component.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#component-file-order',
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
      // Generic on purpose: fires on a misplaced import, and the constraint is "before *every*
      // component", so naming a single component would mislead in a multi-component file.
      importsFirst: 'Imports must come before the component interface and declaration.',
      // "props type" (not "interface"): the rule matches both `interface` and `type` alias props
      // declarations, so the neutral term reads correctly for either.
      interfaceImmediatelyBeforeComponent:
        'Declare the props type `{{interface}}` immediately before component `{{component}}` (no declarations between them).',
      interfaceImmediatelyAfterImports:
        'Declare the props type `{{interface}}` (for component `{{component}}`) immediately after the imports, with no other declarations in between.',
      componentImmediatelyAfterImports:
        'Props type `{{interface}}` is imported, so declare component `{{component}}` immediately after the imports, with no other declarations in between.',
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

        // Leading directive prologue (`'use client'`, ...) — excluded from the stray checks.
        const directiveCount = getDirectivePrologueCount(body)

        const { importIndices, components, declIndexByName, importedNames } = collectTopLevel(body)

        // The rule only governs files that actually contain a component.
        if (components.length === 0) {
          return
        }

        const first = components[0]!
        const firstPropsName = first.propsName
        const firstPropsIndex = firstPropsName === null ? undefined : declIndexByName.get(firstPropsName)
        // `importBoundary` is intentionally directive-insensitive: a leading directive prologue
        // shifts every subsequent index up uniformly, so it never crosses this boundary. The
        // prologue is excluded only from the stray checks, where the raw index matters.
        const importBoundary = Math.min(first.index, firstPropsIndex ?? first.index)

        const violations = [
          ...findImportOrderViolations(importIndices, importBoundary),
          ...findAdjacencyViolations(components, declIndexByName),
          ...findAnchorViolations(
            body,
            directiveCount,
            importIndices,
            first,
            firstPropsName,
            firstPropsIndex,
            importedNames,
          ),
        ]

        for (const violation of violations) {
          context.report({ node: body[violation.index]!, messageId: violation.messageId, data: violation.data })
        }
      },
    }
  },
}
