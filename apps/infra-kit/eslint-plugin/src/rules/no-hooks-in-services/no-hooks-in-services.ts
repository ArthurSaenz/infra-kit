import type { Rule } from 'eslint'
import type * as ESTree from 'estree'

import { isUiPackageFile } from '../../utils/component-file-scope'
import { matchesAnyGlob } from '../../utils/path-match'

interface Options {
  paths?: string[]
  ignore?: string[]
}

// A leading `/` rather than `**/`: path-match's `**/` also matches a bare suffix, so `**/services.ts`
// would catch `lib/use-services.ts`, the very place a hook belongs.
export const DEFAULT_PATHS = [
  '/services/',
  '/services.ts',
  '/services.tsx',
  '/service.ts',
  '/service.tsx',
  '/entities/**/model.ts',
  '/entities/**/model.tsx',
]

const HOOK_NAME = /^use[A-Z0-9]/
const TEST_OR_STORY_DIR = /\/__(?:tests|stories)__\//
const TEST_OR_STORY_FILE = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/

export const noHooksInServices: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow declaring React hooks in services and entity models: they hold atoms and pure functions, the hook belongs in a container or `lib/`.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#no-hooks-in-services',
    },
    schema: [
      {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: `Glob patterns of service files; replaces the default (${DEFAULT_PATHS.join(', ')}).`,
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
      hookInService:
        '"{{name}}" is a hook, and services hold only atoms and pure functions. Move it to a container or to `lib/`.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')
    const ignore = options.ignore ?? []

    if (ignore.length > 0 && matchesAnyGlob(filename, ignore)) {
      return {}
    }

    if (
      !matchesAnyGlob(filename, options.paths ?? DEFAULT_PATHS) ||
      TEST_OR_STORY_DIR.test(filename) ||
      TEST_OR_STORY_FILE.test(filename) ||
      // Backend packages have `src/services/` too, where `use*` means something else.
      !isUiPackageFile(filename)
    ) {
      return {}
    }

    const report = (id: ESTree.Identifier): void => {
      if (HOOK_NAME.test(id.name)) {
        context.report({ node: id, messageId: 'hookInService', data: { name: id.name } })
      }
    }

    return {
      FunctionDeclaration(node) {
        if (node.id) {
          report(node.id)
        }
      },
      VariableDeclarator(node) {
        if (
          node.id.type === 'Identifier' &&
          (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')
        ) {
          report(node.id)
        }
      },
    }
  },
}
