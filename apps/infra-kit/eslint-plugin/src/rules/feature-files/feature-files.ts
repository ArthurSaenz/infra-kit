import type { Rule } from 'eslint'
import fs from 'node:fs'
import path from 'node:path'

import { isUiPackageFile } from '../../utils/component-file-scope'
import { fileDirsUnderSrc, srcDirOf } from '../../utils/import-target'
import { matchesAnyGlob } from '../../utils/path-match'

interface Options {
  /** File names (without extension) allowed directly in a feature root, on top of the defaults. */
  extraRootFiles?: string[]
  /** File names (without extension) allowed directly in a feature's `services/`, on top of the defaults. */
  extraServiceFiles?: string[]
  paths?: string[]
  ignore?: string[]
}

export const ROOT_FILES = ['index', 'types', 'services', 'analytics', 'constants', 'translates']
export const SERVICE_FILES = ['main', 'api', 'libs', 'index', 'types', 'constants']

const SERVICES = 'services'
const TEST_OR_STORY_DIR = /\/__(?:tests|stories)__\//
const EXEMPT_FILE = /\.(?:(?:test|spec|stories)\.[cm]?[jt]sx?|d\.[cm]?ts)$/

const stemOf = (basename: string): string => {
  return basename.slice(0, basename.length - path.posix.extname(basename).length)
}

const describeAllowed = (stems: readonly string[]): string => {
  return stems
    .map((stem) => {
      return `${stem}.ts`
    })
    .join(', ')
}

interface Violation {
  messageId: 'unknownRootFile' | 'unknownServiceFile' | 'servicesFileAndFolder'
  data: Record<string, string>
}

/** `features/<feature>/services.*` or anything under `features/<feature>/services/`. */
const isServiceFile = (filename: string, dirs: readonly string[]): boolean => {
  return dirs[2] === SERVICES || (dirs.length === 2 && stemOf(path.posix.basename(filename)) === SERVICES)
}

/** `dirs` are the file's directories under `src/`, starting `['features', <feature>]`. */
const findNameViolation = (filename: string, dirs: readonly string[], options: Options): Violation | null => {
  const basename = path.posix.basename(filename)
  const stem = stemOf(basename)

  if (dirs.length === 2) {
    const allowed = [...ROOT_FILES, ...(options.extraRootFiles ?? [])]

    if (!allowed.includes(stem)) {
      return { messageId: 'unknownRootFile', data: { file: basename, allowed: describeAllowed(allowed) } }
    }

    // A rule sees one file at a time, so the sibling folder is only visible on disk.
    if (stem === SERVICES && fs.existsSync(path.posix.join(path.posix.dirname(filename), SERVICES))) {
      return { messageId: 'servicesFileAndFolder', data: { feature: dirs[1]! } }
    }

    return null
  }

  // Deeper folders under `services/` are not judged; other segments are package-structure's concern.
  if (dirs.length === 3 && dirs[2] === SERVICES) {
    const allowed = [...SERVICE_FILES, ...(options.extraServiceFiles ?? [])]

    if (!allowed.includes(stem)) {
      return { messageId: 'unknownServiceFile', data: { file: basename, allowed: describeAllowed(allowed) } }
    }
  }

  return null
}

export const featureFiles: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Allow only the conventional files in a feature root and its `services/`, one of `services.ts` or `services/`, and no JSX in services.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#feature-files',
    },
    schema: [
      {
        type: 'object',
        properties: {
          extraRootFiles: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            uniqueItems: true,
            description: `File names without extension allowed in a feature root besides ${ROOT_FILES.join(', ')}.`,
          },
          extraServiceFiles: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            uniqueItems: true,
            description: `File names without extension allowed in \`services/\` besides ${SERVICE_FILES.join(', ')}.`,
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
      unknownRootFile: '"{{file}}" is not an allowed feature-root file. Allowed: {{allowed}}.',
      unknownServiceFile: '"{{file}}" is not an allowed file in `services/`. Allowed: {{allowed}}.',
      servicesFileAndFolder:
        'Feature "{{feature}}" has both `services.ts` and a `services/` folder. Keep one: move this file into `services/main.ts`, or fold the folder into this file.',
      jsxInService: 'Services hold atoms and pure functions; JSX belongs in a component or container.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')
    const paths = options.paths ?? []
    const ignore = options.ignore ?? []

    if (ignore.length > 0 && matchesAnyGlob(filename, ignore)) {
      return {}
    }

    if (paths.length > 0 && !matchesAnyGlob(filename, paths)) {
      return {}
    }

    if (TEST_OR_STORY_DIR.test(filename) || EXEMPT_FILE.test(filename)) {
      return {}
    }

    const srcDir = srcDirOf(filename)

    if (srcDir === null) {
      return {}
    }

    const dirs = fileDirsUnderSrc(filename, srcDir)

    if (dirs[0] !== 'features' || dirs.length < 2 || !isUiPackageFile(filename)) {
      return {}
    }

    const violation = findNameViolation(filename, dirs, options)
    const listeners: Rule.RuleListener = {}

    if (violation !== null) {
      // Reported on Program, like package-structure: the file's name is the problem, not a line in it.
      listeners.Program = (program) => {
        context.report({ ...violation, node: program })
      }
    }

    if (isServiceFile(filename, dirs)) {
      let reported = false

      const reportJsx = (node: Rule.Node): void => {
        if (!reported) {
          reported = true
          context.report({ node, messageId: 'jsxInService' })
        }
      }

      Object.assign(listeners, { JSXElement: reportJsx, JSXFragment: reportJsx })
    }

    return listeners
  },
}
