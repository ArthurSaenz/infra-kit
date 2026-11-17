import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import type { Rule } from 'eslint'
import path from 'node:path'

import { GLOB_SRC_ALL, GLOB_SVELTE } from '../globs.js'
import type { ConfigRules } from '../types.js'

const KEBAB_PART = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LOCALE_FOLDER = /^[a-z]{2}[-_][A-Z]{2}$/

/**
 * Whether a folder name is kebab-case, or a name a tool or framework fixes: dotfolders, `__tests__`-style
 * tooling folders, `$param` / `@param` route segments and scoped-package mocks (`__mocks__/@aws-sdk`).
 * Route syntax around a name is stripped before the check: `_pathless`, `-ignored`, `(group)`, `[id]`,
 * `{-$optional}`, `posts_`, and the `[_]` escape. Dot-separated parts (`popup.legacy`) are checked one by
 * one, except `$param` parts (`posts.$postId`). Locale folders (`pt-BR`, `en_US`) are exempt.
 *
 * @example
 * isKebabFolder('_authenticated') // true
 * isKebabFolder('dataSource') // false
 */
export const isKebabFolder = (name: string): boolean => {
  if (/^[.$@]/.test(name) || /^__[\w-]+__$/.test(name) || LOCALE_FOLDER.test(name)) return true

  const bare = name
    .replaceAll(/[[\](){}]/g, '')
    .replace(/^[_-]+/, '')
    .replace(/_+$/, '')

  return bare.split('.').every((part) => part === '' || part.startsWith('$') || KEBAB_PART.test(part))
}

/** unicorn/filename-case checks names only; this is its folder half, with the exemptions above. */
const folderCase: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require kebab-case folder names (framework- and tool-mandated names exempt).' },
    schema: [],
    messages: { folder: 'Folder name `{{name}}` is not in kebab case.' },
  },
  create: (context) => {
    const relative = path.relative(context.cwd, context.physicalFilename)

    // Outside the lint root, the folders above it belong to someone else.
    if (relative.startsWith('..') || path.isAbsolute(relative)) return {}

    const bad = path
      .dirname(relative)
      .split(path.sep)
      .find((name) => name !== '.' && !isKebabFolder(name))

    if (!bad) return {}

    return {
      Program: (node) => {
        context.report({ node, loc: { line: 1, column: 0 }, messageId: 'folder', data: { name: bad } })
      },
    }
  },
}

/** Local plugin: `@wl` is already registered by `@slip-stream-kit/eslint-plugin`, and a key cannot be redefined. */
export const fileNamingPlugin = { rules: { 'folder-case': folderCase } }

/**
 * Kebab-case file and folder names. Files go through unicorn's `filename-case` (already loaded by antfu),
 * which accepts leading `_` / `$` and `index.*` and checks only the part before the first dot. Its
 * `checkDirectories` is off because an `ignore` match there skips the whole file, so `__tests__/` would
 * hide every name inside it; folders go to `wl-config/folder-case` instead.
 *
 * @example
 * createConfig({ fileNaming: false }) // opt a package out while it is renamed
 */
export const fileNaming: TypedFlatConfigItem = {
  name: 'wl/file-naming',
  files: [GLOB_SRC_ALL, GLOB_SVELTE],
  plugins: { 'wl-config': fileNamingPlugin },
  rules: {
    'unicorn/filename-case': [
      'error',
      {
        case: 'kebabCase',
        checkDirectories: false,
        // TanStack Router: `-` prefixes a file the router skips, a trailing `_` un-nests a segment.
        // Vike: `+Page.tsx`, `+config.ts` and the other `+` hook files.
        ignore: [String.raw`^-.*\.\w+$`, String.raw`^[^.]*_\..*\w$`, String.raw`^\+.*\.\w+$`],
      },
    ],
    'wl-config/folder-case': 'error',
  } as ConfigRules,
}
