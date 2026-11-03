import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { DUMB_COMPONENT_PATHS, isInScope, isStoryOrTestFile, isUiPackageFile } from '../../utils/component-file-scope'

interface Options {
  paths?: string[]
  ignore?: string[]
  allowHooks?: string[]
}

// React's local-state and DOM hooks: everything a dumb component needs without knowing about data.
export const DEFAULT_ALLOWED_HOOKS = [
  'useState',
  'useRef',
  'useMemo',
  'useCallback',
  'useId',
  'useEffect',
  'useLayoutEffect',
  'useImperativeHandle',
]

const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect'])
const HOOK_NAME = /^use[A-Z]/
const ANALYTICS = /analytics/i

/** `useX` for `useX(...)` and `React.useX(...)`, else null. */
const getHookName = (callee: ESTree.CallExpression['callee']): string | null => {
  if (callee.type === 'Identifier') {
    return HOOK_NAME.test(callee.name) ? callee.name : null
  }

  if (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'React' &&
    callee.property.type === 'Identifier' &&
    HOOK_NAME.test(callee.property.name)
  ) {
    return callee.property.name
  }

  return null
}

/** Every identifier name along a callee chain: `window.analytics.track` → window, analytics, track. */
const calleeNames = (node: ESTree.Node): string[] => {
  if (node.type === 'Identifier') {
    return [node.name]
  }

  if (node.type === 'MemberExpression') {
    const property = !node.computed && node.property.type === 'Identifier' ? [node.property.name] : []

    return [...calleeNames(node.object), ...property]
  }

  return []
}

const rootObjectName = (node: ESTree.Node): string | null => {
  if (node.type === 'Identifier') {
    return node.name
  }

  return node.type === 'MemberExpression' ? rootObjectName(node.object) : null
}

const isSideEffectCall = (callee: ESTree.CallExpression['callee']): boolean => {
  if (callee.type === 'Identifier' && callee.name === 'fetch') {
    return true
  }

  if (callee.type === 'MemberExpression' && rootObjectName(callee) === 'httpClient') {
    return true
  }

  return calleeNames(callee).some((name) => {
    return ANALYTICS.test(name)
  })
}

export const dumbComponentPurity: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Keep dumb components pure: only React's local-state hooks are allowed, and effects may not fetch, call `httpClient` or send analytics.",
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#dumb-component-purity',
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
              'Glob patterns of files to skip, even if they also match `paths`. Stories and tests are always skipped.',
          },
          allowHooks: {
            type: 'array',
            items: { type: 'string' },
            description: `Hooks allowed on top of the defaults (${DEFAULT_ALLOWED_HOOKS.join(', ')}), e.g. UI-library hooks like \`useMediaQuery\`.`,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbiddenHook:
        '"{{hook}}" is not in the allowed hook list for dumb components. Call it in the container and pass the value as a prop.',
      sideEffectInEffect:
        '`{{call}}` is a side effect a dumb component must not run. Move it to the container and pass a callback or the result as a prop.',
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

    const allowed = new Set([...DEFAULT_ALLOWED_HOOKS, ...(options.allowHooks ?? [])])
    const effectCallbacks = new Set<ESTree.Node>()

    return {
      CallExpression(node) {
        const hook = getHookName(node.callee)

        if (hook !== null && !allowed.has(hook)) {
          context.report({ node: node.callee, messageId: 'forbiddenHook', data: { hook } })
        }

        if (hook !== null && EFFECT_HOOKS.has(hook) && node.arguments[0]) {
          effectCallbacks.add(node.arguments[0])
        }

        if (!isSideEffectCall(node.callee)) {
          return
        }

        // Effects are entered before their body is visited, so an enclosing callback is already registered.
        const inEffect = context.sourceCode.getAncestors(node).some((ancestor) => {
          return effectCallbacks.has(ancestor)
        })

        if (inEffect) {
          context.report({
            node: node.callee,
            messageId: 'sideEffectInEffect',
            data: { call: context.sourceCode.getText(node.callee) },
          })
        }
      },
    }
  },
}
