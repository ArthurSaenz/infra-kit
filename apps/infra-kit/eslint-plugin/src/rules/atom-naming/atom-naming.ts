import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { matchesAnyGlob } from '../../utils/path-match'

interface Options {
  asyncSuffix?: string
  syncSuffix?: string
  argsSuffix?: string
  readablePrefix?: string
  paths?: string[]
  ignore?: string[]
}

const ATOM_FACTORIES = new Set([
  'atom',
  'atomWithStorage',
  'atomWithReset',
  'atomWithDefault',
  'atomFamily',
  'loadable',
  'selectAtom',
  'splitAtom',
  'focusAtom',
])

// TS-only nodes are not modelled by estree.
interface TypedPattern {
  typeAnnotation?: {
    typeAnnotation?: { type: string; typeName?: { type: string; name?: string } }
  }
}

const isWriteOnly = (call: ESTree.CallExpression): boolean => {
  const [read, write] = call.arguments

  // `atom<T | null>(null)` is a primitive atom; only a `null` read paired with a write is write-only.
  return (
    call.callee.type === 'Identifier' &&
    call.callee.name === 'atom' &&
    read?.type === 'Literal' &&
    read.value === null &&
    write !== undefined
  )
}

const asFunction = (
  node: ESTree.Node | undefined,
): ESTree.ArrowFunctionExpression | ESTree.FunctionExpression | null => {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression' ? node : null
}

const isNamedArgsType = (param: ESTree.Pattern, argsSuffix: string): boolean => {
  const target = param.type === 'AssignmentPattern' ? param.left : param

  if (target.type === 'RestElement') {
    return false
  }

  const annotation = (target as TypedPattern).typeAnnotation?.typeAnnotation

  // Unannotated args are typed through the `atom<…>` generics or are implicit `any`; tsc owns both.
  if (annotation === undefined) {
    return true
  }

  return (
    annotation.type === 'TSTypeReference' &&
    annotation.typeName?.type === 'Identifier' &&
    annotation.typeName.name!.endsWith(argsSuffix)
  )
}

/** `toggleOpenedCardAtom` → `ToggleOpenedCardArgs`, for the message's example. */
const exampleArgsType = (name: string, suffixes: string[], argsSuffix: string): string => {
  const suffix = suffixes.find((candidate) => {
    return name.endsWith(candidate) && name.length > candidate.length
  })

  const base = (suffix === undefined ? name : name.slice(0, -suffix.length)).replace(/^\$+/, '')

  return `${base.charAt(0).toUpperCase()}${base.slice(1)}${argsSuffix}`
}

export const atomNaming: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require readable Jotai atoms to start with `$`, write-only atoms to end with `Fx` (async) or `Atom` (sync), and write-only atoms to take a single `*Args` object.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#atom-naming',
    },
    schema: [
      {
        type: 'object',
        properties: {
          asyncSuffix: {
            type: 'string',
            minLength: 1,
            description: "Suffix of an async write-only atom (default 'Fx').",
          },
          syncSuffix: {
            type: 'string',
            minLength: 1,
            description: "Suffix of a sync write-only atom (default 'Atom').",
          },
          argsSuffix: {
            type: 'string',
            minLength: 1,
            description: "Suffix of the type naming a write-only atom's argument (default 'Args').",
          },
          readablePrefix: {
            type: 'string',
            minLength: 1,
            description: "Prefix of a readable atom (default '$').",
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
      readablePrefix: 'Readable atom "{{name}}" must start with "{{prefix}}" (e.g. "{{expected}}").',
      writeOnlyPrefix: 'Write-only atom "{{name}}" must not start with "{{prefix}}": that prefix marks readable atoms.',
      writeOnlySuffix: 'Write-only atom "{{name}}" must end with {{expected}}.',
      argsNotNamed:
        'Write-only atom "{{name}}" must take a single argument typed with a named `*{{suffix}}` type (e.g. `args: {{example}}`).',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const paths = options.paths ?? []
    const ignore = options.ignore ?? []

    if (ignore.length > 0 && matchesAnyGlob(context.filename, ignore)) {
      return {}
    }

    if (paths.length > 0 && !matchesAnyGlob(context.filename, paths)) {
      return {}
    }

    const asyncSuffix = options.asyncSuffix ?? 'Fx'
    const syncSuffix = options.syncSuffix ?? 'Atom'
    const argsSuffix = options.argsSuffix ?? 'Args'
    const prefix = options.readablePrefix ?? '$'

    const checkWriteOnly = (id: ESTree.Identifier, call: ESTree.CallExpression): void => {
      const { name } = id
      const write = asFunction(call.arguments[1])

      if (name.startsWith(prefix)) {
        context.report({ node: id, messageId: 'writeOnlyPrefix', data: { name, prefix } })
      }

      // A write function passed by reference cannot be seen to be async, so either suffix passes.
      const asyncForm = { suffix: asyncSuffix, kind: 'async' }
      const syncForm = { suffix: syncSuffix, kind: 'sync' }
      let accepted = [asyncForm, syncForm]

      if (write !== null) {
        accepted = [write.async ? asyncForm : syncForm]
      }

      const hasSuffix = accepted.some((form) => {
        return name.endsWith(form.suffix)
      })

      if (!hasSuffix) {
        const expected = accepted
          .map((form) => {
            return `"${form.suffix}" (${form.kind})`
          })
          .join(' or ')

        context.report({ node: id, messageId: 'writeOnlySuffix', data: { name, expected } })
      }

      // Jotai's write signature is `(get, set, ...args)`: everything past `set` is the caller's input.
      const inputs = write?.params.slice(2) ?? []

      if (inputs.length === 0) {
        return
      }

      if (inputs.length > 1 || !isNamedArgsType(inputs[0]!, argsSuffix)) {
        context.report({
          node: inputs[0]!,
          messageId: 'argsNotNamed',
          data: { name, suffix: argsSuffix, example: exampleArgsType(name, [asyncSuffix, syncSuffix], argsSuffix) },
        })
      }
    }

    const check = (node: ESTree.VariableDeclarator): void => {
      const { id, init } = node

      if (
        id.type !== 'Identifier' ||
        init?.type !== 'CallExpression' ||
        init.callee.type !== 'Identifier' ||
        !ATOM_FACTORIES.has(init.callee.name)
      ) {
        return
      }

      if (isWriteOnly(init)) {
        checkWriteOnly(id, init)

        return
      }

      // Everything else is readable: primitive, derived, read-write, and `atomFamily(...)`, whose
      // members are read through the family even when they are write-only themselves.
      if (!id.name.startsWith(prefix)) {
        context.report({
          node: id,
          messageId: 'readablePrefix',
          data: { name: id.name, prefix, expected: `${prefix}${id.name}` },
        })
      }
    }

    return {
      'Program > VariableDeclaration > VariableDeclarator': check,
      'Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator': check,
    }
  },
}
