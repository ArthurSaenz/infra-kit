import type { Rule, Scope, SourceCode } from 'eslint'
import type { Node as EsNode, ImportDeclaration, ImportNamespaceSpecifier, Program } from 'estree'

import { isInScope, isUiPackageFile } from '../../utils/component-file-scope'

interface Options {
  /** The namespace binding every services import must use. */
  name?: string
  paths?: string[]
  ignore?: string[]
}

const DEFAULT_NAME = 'service'

// A barrel re-exports the services under a public, module-specific name (`export * as fooService`).
const BARREL_FILE = /\/index\.[cm]?[jt]sx?$/

/** A relative path to a `services.ts` file or a `services/` folder barrel. */
const SERVICES_SPECIFIER = /^\.{1,2}\/(?:.*\/)?services(?:\/index)?(?:\.[cm]?[jt]sx?)?$/

type Specifier = ImportDeclaration['specifiers'][number]

interface Replacement {
  range: [number, number]
  text: string
}

interface GroupContext {
  context: Rule.RuleContext
  sourceCode: SourceCode
  source: string
  group: ImportDeclaration[]
  name: string
  /** False when any fix for this group could clash with another binding. */
  canFix: boolean
}

const isTypeOnly = (node: ImportDeclaration | Specifier): boolean => {
  return (node as { importKind?: string }).importKind === 'type'
}

const isValueBinding = (specifier: Specifier): boolean => {
  return specifier.type !== 'ImportNamespaceSpecifier' && !isTypeOnly(specifier)
}

const importedName = (specifier: Specifier): string => {
  if (specifier.type === 'ImportDefaultSpecifier') {
    return 'default'
  }

  if (specifier.type === 'ImportSpecifier') {
    return specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value)
  }

  return specifier.local.name
}

/** Whether a scope between `reference` and the module scope declares its own `name`. */
const isShadowedAt = (reference: Scope.Reference, name: string): boolean => {
  let scope: Scope.Scope | null = reference.from

  while (scope !== null && scope.type !== 'module' && scope.type !== 'global') {
    if (scope.set.has(name)) {
      return true
    }

    scope = scope.upper
  }

  return false
}

/** JSX tag names and local re-exports cannot take a `namespace.member` form, so they block the fix. */
const isRewritable = (reference: Scope.Reference, name: string): boolean => {
  const identifier = reference.identifier as EsNode & { parent?: EsNode }

  return (
    (identifier.type as string) !== 'JSXIdentifier' &&
    identifier.parent?.type !== 'ExportSpecifier' &&
    !isShadowedAt(reference, name)
  )
}

const referenceEdit = (reference: Scope.Reference, local: string, member: string): Replacement => {
  const identifier = reference.identifier as EsNode & { parent?: EsNode }
  const parent = identifier.parent

  // `{ foo }` must keep its key once the value becomes `service.foo`.
  if (parent?.type === 'Property' && parent.shorthand && parent.value === identifier) {
    return { range: parent.range!, text: `${local}: ${member}` }
  }

  return { range: identifier.range!, text: member }
}

/** Edits that point every reference of each binding at `${name}.<member>`; null when one cannot be rewritten. */
const rewriteBindings = (
  bindings: readonly { variable: Scope.Variable; member: string }[],
  name: string,
): Replacement[] | null => {
  const references = bindings.flatMap(({ variable, member }) => {
    return variable.references.map((reference) => {
      return { reference, local: variable.name, member }
    })
  })

  const allRewritable = references.every(({ reference }) => {
    return isRewritable(reference, name)
  })

  if (!allRewritable) {
    return null
  }

  return references.map(({ reference, local, member }) => {
    return referenceEdit(reference, local, member === '' ? name : `${name}.${member}`)
  })
}

const typeImportLine = (declaration: ImportDeclaration, sourceCode: SourceCode): string | null => {
  const names = declaration.specifiers.filter(isTypeOnly).map((specifier) => {
    return sourceCode.getText(specifier).replace(/^type\s+/, '')
  })

  return names.length === 0
    ? null
    : `import type { ${names.join(', ')} } from ${sourceCode.getText(declaration.source)}`
}

/** Removes a whole import line, its trailing newline included. */
const lineRange = (declaration: ImportDeclaration, sourceCode: SourceCode): [number, number] => {
  const [start, end] = declaration.range!

  return [start, sourceCode.text[end] === '\n' ? end + 1 : end]
}

/** Whether `name` is bound at module level by anything other than `except`. */
const isNameTaken = (sourceCode: SourceCode, program: Program, name: string, except?: EsNode): boolean => {
  const moduleScope = sourceCode.getScope(program).childScopes.find((scope) => {
    return scope.type === 'module'
  })

  const variable = moduleScope?.set.get(name)

  return (
    variable !== undefined &&
    variable.defs.some((def) => {
      return def.node !== except
    })
  )
}

const namespacesOf = (group: readonly ImportDeclaration[]): ImportNamespaceSpecifier[] => {
  return group.flatMap((declaration) => {
    return declaration.specifiers.filter((specifier): specifier is ImportNamespaceSpecifier => {
      return specifier.type === 'ImportNamespaceSpecifier'
    })
  })
}

const reportWrongNamespaces = (ctx: GroupContext, wrong: readonly ImportNamespaceSpecifier[]): void => {
  const { context, sourceCode, source, name } = ctx

  for (const specifier of wrong) {
    const variable = sourceCode.getDeclaredVariables(specifier)[0]

    // Only a lone wrongly named namespace can be renamed; two of them would collapse into one binding.
    const edits =
      ctx.canFix && wrong.length === 1 && variable ? rewriteBindings([{ variable, member: '' }], name) : null

    context.report({
      node: specifier,
      messageId: 'namespaceName',
      data: { source, name, actual: specifier.local.name },
      fix:
        edits === null
          ? null
          : (fixer) => {
              return [
                fixer.replaceText(specifier.local, name),
                ...edits.map((edit) => {
                  return fixer.replaceTextRange(edit.range, edit.text)
                }),
              ]
            },
    })
  }
}

const reportNamedImports = (
  ctx: GroupContext,
  offending: readonly ImportDeclaration[],
  hasNamespace: boolean,
): void => {
  const { context, sourceCode, source, name } = ctx

  const bindings = offending.flatMap((declaration) => {
    return declaration.specifiers.filter(isValueBinding).map((specifier) => {
      return { variable: sourceCode.getDeclaredVariables(specifier)[0]!, member: importedName(specifier) }
    })
  })

  const edits = ctx.canFix ? rewriteBindings(bindings, name) : null
  // The first offending line becomes the namespace import unless one already exists; the others go away.
  const host = hasNamespace ? undefined : offending[0]

  const declarationFix = (fixer: Rule.RuleFixer, declaration: ImportDeclaration): Rule.Fix => {
    const lines = [
      declaration === host ? `import * as ${name} from ${sourceCode.getText(declaration.source)}` : null,
      typeImportLine(declaration, sourceCode),
    ].filter((line) => {
      return line !== null
    })

    return lines.length === 0
      ? fixer.removeRange(lineRange(declaration, sourceCode))
      : fixer.replaceText(declaration, lines.join('\n'))
  }

  for (const declaration of offending) {
    // ESLint merges a report's fixes into one span, so separate reports would overlap and drop each
    // other's edits: the first report carries the whole group's rewrite.
    context.report({
      node: declaration,
      messageId: 'namedImport',
      data: { source, name },
      fix:
        edits === null || declaration !== offending[0]
          ? null
          : (fixer) => {
              return [
                ...offending.map((each) => {
                  return declarationFix(fixer, each)
                }),
                ...edits.map((edit) => {
                  return fixer.replaceTextRange(edit.range, edit.text)
                }),
              ]
            },
    })
  }
}

const checkGroup = (ctx: GroupContext, program: Program): void => {
  const namespaces = namespacesOf(ctx.group)

  const correct = namespaces.find((specifier) => {
    return specifier.local.name === ctx.name
  })

  const wrong = namespaces.filter((specifier) => {
    return specifier !== correct
  })

  const nameTaken = isNameTaken(ctx.sourceCode, program, ctx.name, correct)

  reportWrongNamespaces({ ...ctx, canFix: ctx.canFix && correct === undefined && !nameTaken }, wrong)

  const offending = ctx.group.filter((declaration) => {
    return declaration.specifiers.some(isValueBinding)
  })

  if (offending.length > 0) {
    // A wrongly named namespace fixes first; the named imports fix on the next pass.
    reportNamedImports({ ...ctx, canFix: ctx.canFix && wrong.length === 0 && !nameTaken }, offending, !!correct)
  }
}

export const servicesNamespaceImport: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: {
      description:
        "Import a feature's `services` module only as a namespace (`import * as service from '../services'`).",
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#services-namespace-import',
    },
    schema: [
      {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            description: `The namespace binding (default '${DEFAULT_NAME}').`,
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
      namedImport:
        "Import `{{source}}` as a namespace — `import * as {{name}} from '{{source}}'` — and read members as `{{name}}.<member>`.",
      namespaceName: 'Name the `{{source}}` namespace `{{name}}`, not `{{actual}}`.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')

    if (
      BARREL_FILE.test(filename) ||
      !isInScope(filename, options.paths ?? [], options.ignore ?? []) ||
      !isUiPackageFile(filename)
    ) {
      return {}
    }

    const declarations: ImportDeclaration[] = []

    return {
      ImportDeclaration(node) {
        if (!isTypeOnly(node) && typeof node.source.value === 'string' && SERVICES_SPECIFIER.test(node.source.value)) {
          declarations.push(node)
        }
      },

      'Program:exit': function (program: Program) {
        const bySource = Map.groupBy(declarations, (declaration) => {
          return String(declaration.source.value)
        })

        for (const [source, group] of bySource) {
          checkGroup(
            {
              context,
              sourceCode: context.sourceCode,
              source,
              group,
              name: options.name ?? DEFAULT_NAME,
              // Two different services modules cannot share one namespace name.
              canFix: bySource.size === 1,
            },
            program,
          )
        }
      },
    }
  },
}
