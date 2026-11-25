import type { Rule } from 'eslint'
import fs from 'node:fs'
import path from 'node:path'

import { dirsUnderSrc, findPackageRoot } from '../../utils/package-root'
import { resolvePackageType } from '../../utils/package-type-reader'
import { matchesAnyGlob } from '../../utils/path-match'

export interface Options {
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

const SERVICES = 'services'
const TESTS = '__tests__'
const SOURCE_EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']
const PLAIN_ROOT_FILE = /^(?:index|types|constants)\.[cm]?[jt]s$/
const SERVICE_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.service\.[cm]?[jt]s$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const SEE_SKILL = ' See /infra-kit:be-architect for the backend service layout.'

type MessageId = 'flatFile' | 'testsOutsideDomain' | 'unknownFile' | 'missingIndex'

interface Violation {
  messageId: MessageId
  data: Record<string, string>
}

const hasIndex = (domainDir: string): boolean => {
  return SOURCE_EXTENSIONS.some((extension) => {
    return fs.existsSync(path.posix.join(domainDir, `index.${extension}`))
  })
}

/** `dirs` are the file's directories under `srcDir`, starting with `services`. */
const findViolations = (filename: string, srcDir: string, dirs: readonly string[]): Violation[] => {
  const file = path.posix.basename(filename)

  if (dirs.length === 1) {
    return [{ messageId: 'flatFile', data: { file } }]
  }

  const domain = dirs[1]!

  if (domain === TESTS) {
    return [{ messageId: 'testsOutsideDomain', data: { file } }]
  }

  const violations: Violation[] = []

  // Only the domain root is name-checked: `lib/` names are free, `__tests__/` belongs to test-location.
  if (dirs.length === 2 && !PLAIN_ROOT_FILE.test(file) && !SERVICE_FILE.test(file)) {
    violations.push({ messageId: 'unknownFile', data: { file, domain } })
  }

  // A rule sees one file at a time, so the sibling `index.ts` is only visible on disk.
  if (!hasIndex(`${srcDir}/${SERVICES}/${domain}`)) {
    violations.push({ messageId: 'missingIndex', data: { domain } })
  }

  return violations
}

export const serviceFiles: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every backend service to live in a `services/<domain>/` folder with an `index.ts` and only the conventional files.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#service-files',
    },
    schema: [
      {
        type: 'object',
        properties: {
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional globs; the rule is skipped for matching files.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      flatFile: `\`{{file}}\` sits directly in \`services/\`. Every service lives in a domain folder: move it to \`services/<domain>/\` and expose it through that folder's \`index.ts\`.${SEE_SKILL}`,
      testsOutsideDomain: `\`services/__tests__/\` is not a domain. Move \`{{file}}\` into the \`__tests__/\` of the domain it covers, or into \`src/__tests__/\` when it spans several domains.${SEE_SKILL}`,
      unknownFile: `\`{{file}}\` is not an allowed file in domain \`{{domain}}\`. Allowed: index.ts, <kebab-name>.service.ts, types.ts, constants.ts; helpers go in \`lib/\`, tests in \`__tests__/\`.${SEE_SKILL}`,
      missingIndex: `Domain \`{{domain}}\` has no \`index.ts\`. Add \`services/{{domain}}/index.ts\`: it is the domain's public API and the only entry from outside.${SEE_SKILL}`,
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')
    const ignore = options.ignore ?? []

    if (DECLARATION_FILE.test(filename) || (ignore.length > 0 && matchesAnyGlob(filename, ignore))) {
      return {}
    }

    const packageRoot = findPackageRoot(filename)

    if (packageRoot === null || resolvePackageType(packageRoot) !== 'backend') {
      return {}
    }

    const dirs = dirsUnderSrc(packageRoot, filename)

    if (dirs === null || dirs[0] !== SERVICES) {
      return {}
    }

    const violations = findViolations(filename, `${packageRoot}/src`, dirs)

    if (violations.length === 0) {
      return {}
    }

    return {
      // Reported on Program, like package-structure: the file's place is the problem, not a line in it.
      Program(program) {
        for (const violation of violations) {
          context.report({ ...violation, node: program })
        }
      },
    }
  },
}
