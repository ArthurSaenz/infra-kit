import type { Rule } from 'eslint'

import { findPackageRoot } from '../../utils/package-root'
import { resolvePackageType } from '../../utils/package-type-reader'
import { matchesAnyGlob } from '../../utils/path-match'

export interface Options {
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const SPEC_SUFFIX = /\.spec(\.[cm]?[jt]sx?)$/
const TESTS_DIR = '__tests__'
const FEATURES_DIR = 'features'

type MessageId = 'outsideTestsDir' | 'outsideFeatureTestsDir' | 'specSuffix'

interface Violation {
  messageId: MessageId
  data: Record<string, string>
}

/** Relative from `src/` keeps the message short and still unambiguous inside a package. */
const fromSrc = (dirs: readonly string[]): string[] => {
  const srcIndex = dirs.lastIndexOf('src')

  return srcIndex >= 0 ? dirs.slice(srcIndex) : dirs.slice(-1)
}

/**
 * The directory of the feature `dirs` sits in (`…/src/…/features/<name>`), or null outside a
 * feature. Only a `features/` below `src/` counts, so a checkout path that happens to contain one
 * cannot turn every test into a feature test; the innermost wins so a nested feature owns its tests.
 */
const featureRoot = (dirs: readonly string[]): string[] | null => {
  const srcIndex = dirs.lastIndexOf('src')
  const featuresIndex = dirs.lastIndexOf(FEATURES_DIR)

  return srcIndex >= 0 && featuresIndex > srcIndex && featuresIndex + 1 < dirs.length
    ? dirs.slice(0, featuresIndex + 2)
    : null
}

const locationViolation = (dirs: readonly string[], basename: string): Violation | null => {
  const feature = featureRoot(dirs)

  // A feature keeps every test in its root `__tests__/` (the `/infra-kit:fe-architect` layout), so a
  // `services/__tests__/` inside it is as misplaced as a test next to its source.
  if (feature !== null) {
    if (dirs[feature.length] === TESTS_DIR) {
      return null
    }

    return {
      messageId: 'outsideFeatureTestsDir',
      data: { basename, target: [...fromSrc(feature), TESTS_DIR, basename].join('/') },
    }
  }

  if (dirs.includes(TESTS_DIR)) {
    return null
  }

  return {
    messageId: 'outsideTestsDir',
    data: { basename, target: [...fromSrc(dirs), TESTS_DIR, basename].join('/') },
  }
}

const findViolations = (filename: string, ignore: readonly string[]): Violation[] => {
  if (!TEST_FILE.test(filename) || (ignore.length > 0 && matchesAnyGlob(filename, ignore))) {
    return []
  }

  // e2e packages keep specs under `tests/*` by their own layout (see `e2e-file-layout`).
  const packageRoot = findPackageRoot(filename)

  if (packageRoot !== null && resolvePackageType(packageRoot) === 'e2e') {
    return []
  }

  const dirs = filename.split('/')
  const basename = dirs.pop()!
  const location = locationViolation(dirs, basename)
  const suffix: Violation | null = SPEC_SUFFIX.test(basename)
    ? { messageId: 'specSuffix', data: { basename, target: basename.replace(SPEC_SUFFIX, '.test$1') } }
    : null

  return [location, suffix].filter((violation): violation is Violation => {
    return violation !== null
  })
}

export const testLocation: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require unit tests to be `*.test.*` files in a `__tests__/` folder beside the code they test — the feature root’s inside a frontend feature.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#test-location',
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
      outsideTestsDir:
        '`{{basename}}` sits next to its source. Move it to `{{target}}` — tests live in a `__tests__/` folder beside the code they test.',
      outsideFeatureTestsDir:
        '`{{basename}}` is a feature test outside the feature root. Move it to `{{target}}` — a feature keeps all its tests in one `__tests__/` at its root.',
      specSuffix:
        '`{{basename}}` uses `.spec`. Rename it to `{{target}}` — unit tests are `*.test.*`; `.spec` belongs to Playwright specs in an e2e package.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const violations = findViolations(context.filename.split('\\').join('/'), options.ignore ?? [])

    if (violations.length === 0) {
      return {}
    }

    return {
      // Reported on Program: the violation is the file's location, not any node inside it.
      Program(program) {
        for (const violation of violations) {
          context.report({ node: program, messageId: violation.messageId, data: violation.data })
        }
      },
    }
  },
}
