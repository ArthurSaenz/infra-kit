import type { Rule } from 'eslint'

import { dirsUnderSrc, findPackageRoot } from '../../utils/package-root'
import { resolvePackageType } from '../../utils/package-type-reader'
import { matchesAnyGlob } from '../../utils/path-match'

export interface Options {
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const LEGACY_TEST_SUFFIX = /\.test(\.[cm]?[jt]sx?)$/
const SPEC_LAYERS = new Set(['tests', 'visual'])

/** Support-file suffix → the domain subfolder it belongs in; anything unmatched is a domain helper. */
const SUBFOLDER_BY_SUFFIX: readonly (readonly [RegExp, string])[] = [
  [/\.(?:page|component)\.[cm]?[jt]sx?$/, 'pages'],
  [/\.fixture\.[cm]?[jt]sx?$/, 'fixtures'],
  [/\.mock\.[cm]?[jt]sx?$/, 'mocks'],
  [/\.data\.[cm]?[jt]sx?$/, 'data'],
]

type MessageId = 'legacyTestSuffix' | 'specOutsideDomain' | 'nestedSpec' | 'supportInDomainRoot'

interface Violation {
  messageId: MessageId
  data: Record<string, string>
}

const subfolderFor = (basename: string): string => {
  const match = SUBFOLDER_BY_SUFFIX.find(([pattern]) => {
    return pattern.test(basename)
  })

  return match ? match[1] : 'lib'
}

const specViolation = (dirs: readonly string[], basename: string): Violation | null => {
  if (LEGACY_TEST_SUFFIX.test(basename)) {
    return {
      messageId: 'legacyTestSuffix',
      data: { basename, target: basename.replace(LEGACY_TEST_SUFFIX, '.spec$1') },
    }
  }

  const [layer, domain] = dirs

  if (layer === undefined || !SPEC_LAYERS.has(layer) || domain === undefined) {
    return { messageId: 'specOutsideDomain', data: { basename, path: ['src', ...dirs, basename].join('/') } }
  }

  if (dirs.length > 2) {
    return {
      messageId: 'nestedSpec',
      data: { basename, path: ['src', ...dirs, basename].join('/'), target: `src/${layer}/${domain}/${basename}` },
    }
  }

  return null
}

const supportViolation = (dirs: readonly string[], basename: string): Violation | null => {
  const [layer, domain] = dirs

  if (dirs.length !== 2 || layer === undefined || !SPEC_LAYERS.has(layer) || domain === undefined) {
    return null
  }

  const subfolder = subfolderFor(basename)

  return {
    messageId: 'supportInDomainRoot',
    data: { basename, domain, subfolder, target: `src/${layer}/${domain}/${subfolder}/${basename}` },
  }
}

/** The layout problem with `filename`, or null when it is fine or not an e2e source file. */
const findViolation = (filename: string, ignore: readonly string[]): Violation | null => {
  if (ignore.length > 0 && matchesAnyGlob(filename, ignore)) {
    return null
  }

  const packageRoot = findPackageRoot(filename)

  if (packageRoot === null || resolvePackageType(packageRoot) !== 'e2e') {
    return null
  }

  const dirs = dirsUnderSrc(packageRoot, filename)

  if (dirs === null) {
    return null
  }

  const basename = filename.slice(filename.lastIndexOf('/') + 1)

  return TEST_FILE.test(basename) ? specViolation(dirs, basename) : supportViolation(dirs, basename)
}

export const e2eFileLayout: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require e2e packages to keep `*.spec.ts` files at the root of `src/tests/<domain>/` and every other file in a domain subfolder.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#e2e-file-layout',
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
      legacyTestSuffix:
        '`{{basename}}` uses `.test`. Rename it to `{{target}}` — every Playwright spec in an e2e package is `*.spec.ts`.',
      specOutsideDomain:
        '`{{path}}` is a spec outside a domain folder. Move it into `src/tests/<domain>/`, where `<domain>` is the business domain it covers.',
      nestedSpec:
        '`{{path}}` nests a spec below its domain folder. Move it to `{{target}}`, or split the domain into two sibling domains if it holds too many specs.',
      supportInDomainRoot:
        '`{{basename}}` sits in the root of domain `{{domain}}`, which holds only `*.spec.ts`. Move it to `{{target}}`.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const violation = findViolation(context.filename.split('\\').join('/'), options.ignore ?? [])

    if (violation === null) {
      return {}
    }

    return {
      // Reported on Program: the violation is the file's location, not any node inside it.
      Program(program) {
        context.report({ node: program, messageId: violation.messageId, data: violation.data })
      },
    }
  },
}
