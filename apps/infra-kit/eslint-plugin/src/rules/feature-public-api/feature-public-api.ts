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

export const featurePublicApi: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require code outside a feature to import it only through its public API (`features/<name>` / its `index`), whatever the path form.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#feature-public-api',
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
      deepImport:
        '`{{specifier}}` reaches into the internals of feature `{{feature}}`. Import from its public API `{{publicApi}}` instead, exporting what you need from `features/{{feature}}/index.ts`.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')
    const srcDir = srcDirOf(filename)

    if (srcDir === null || !isLayeredFile(filename, options.ignore ?? [])) {
      return {}
    }

    const rootAlias = options.rootAlias ?? DEFAULT_ROOT_ALIAS
    const ownFeature = featureNameOf(fileDirsUnderSrc(filename, srcDir))

    const check = (node: Rule.Node): void => {
      const source = readImportSource(node)
      const target = source === null ? null : resolveUnderSrc(filename, srcDir, source.specifier, rootAlias)
      const feature = target === null ? null : featureNameOf(target)

      if (source === null || feature === null || feature === ownFeature || isFeaturePublicApi(target!)) {
        return
      }

      context.report({
        node: source.node,
        messageId: 'deepImport',
        data: { specifier: source.specifier, feature, publicApi: `${rootAlias}/features/${feature}` },
      })
    }

    return Object.fromEntries(
      IMPORT_SELECTORS.map((selector) => {
        return [selector, check]
      }),
    )
  },
}
