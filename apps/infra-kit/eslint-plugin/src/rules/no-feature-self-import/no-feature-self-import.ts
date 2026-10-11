import type { Rule } from 'eslint'

import {
  DEFAULT_ROOT_ALIAS,
  IMPORT_SELECTORS,
  featureNameOf,
  fileDirsUnderSrc,
  isFeaturePublicApi,
  isLayeredFile,
  readImportSource,
  resolveUnderSrc,
  srcDirOf,
} from '../../utils/import-target'

export interface Options {
  /** The alias that maps to the package's `src/`. */
  rootAlias?: string
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

// Tests and stories exercise the feature from outside, so its public API is the right entry for them.
const CONSUMER_DIRS = new Set(['__tests__', '__stories__'])

export const noFeatureSelfImport: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid a feature from importing itself through its own public API, which closes an import cycle through `index.ts`.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#no-feature-self-import',
    },
    schema: [
      {
        type: 'object',
        properties: {
          rootAlias: { type: 'string', description: 'The alias that maps to `src/` (default `#root`).' },
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
      selfImport:
        '`{{specifier}}` imports feature `{{feature}}` through its own public API from inside it, which makes an import cycle via `index.ts`. Import the module that defines it with a relative path instead.',
      selfTypeImport:
        '`{{specifier}}` reads types of feature `{{feature}}` through its own public API from inside it. Import them from the module that defines them with a relative path; the public API is for code outside the feature.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')
    const srcDir = srcDirOf(filename)

    if (srcDir === null || !isLayeredFile(filename, options.ignore ?? [])) {
      return {}
    }

    const dirs = fileDirsUnderSrc(filename, srcDir)
    const ownFeature = featureNameOf(dirs)

    const isConsumer = dirs.some((dir) => {
      return CONSUMER_DIRS.has(dir)
    })

    if (ownFeature === null || isConsumer) {
      return {}
    }

    const rootAlias = options.rootAlias ?? DEFAULT_ROOT_ALIAS

    const check = (node: Rule.Node): void => {
      const source = readImportSource(node)
      const target = source === null ? null : resolveUnderSrc(filename, srcDir, source.specifier, rootAlias)

      if (source === null || target === null || featureNameOf(target) !== ownFeature || !isFeaturePublicApi(target)) {
        return
      }

      context.report({
        node: source.node,
        // A type-only import is erased at build time, so it closes no runtime cycle.
        messageId: source.typeOnly ? 'selfTypeImport' : 'selfImport',
        data: { specifier: source.specifier, feature: ownFeature },
      })
    }

    return Object.fromEntries(
      IMPORT_SELECTORS.map((selector) => {
        return [selector, check]
      }),
    )
  },
}
