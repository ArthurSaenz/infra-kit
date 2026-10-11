import type { Rule } from 'eslint'

import {
  DEFAULT_ROOT_ALIAS,
  IMPORT_SELECTORS,
  fileDirsUnderSrc,
  isLayeredFile,
  readImportSource,
  resolveUnderSrc,
  srcDirOf,
} from '../../utils/import-target'

export interface Options {
  /** Folders under `src/`, lowest level first; folders in one inner array share a level. */
  layers?: string[][]
  /** Type-only imports carry no runtime edge, so they may point at any level. */
  allowTypeImports?: boolean
  /** The alias that maps to the package's `src/`. */
  rootAlias?: string
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

// `renderer` and `mobile` are entry points like `app`: they mount pages, nothing imports them.
// A test assembles its own environment (global styles, app providers) the way an entry point does,
// and it is not part of the runtime graph the layers protect.
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

const isTestFile = (filename: string): boolean => {
  return filename.includes('/__tests__/') || TEST_FILE.test(filename)
}

export const DEFAULT_LAYERS: string[][] = [
  ['lib', 'components', 'shared', 'assets', 'styles', 'data'],
  ['core', 'entities'],
  ['features'],
  ['pages', 'routes'],
  ['app', 'renderer', 'mobile'],
]

const levelIndex = (layers: readonly string[][]): Map<string, number> => {
  return new Map(
    layers.flatMap((level, index) => {
      return level.map((layer): [string, number] => {
        return [layer, index]
      })
    }),
  )
}

const describeOrder = (layers: readonly string[][]): string => {
  return layers
    .map((level) => {
      return level.join(', ')
    })
    .join(' → ')
}

export const layerImports: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Allow imports only to the same or a lower layer of `src/` (lib/components → entities → features → pages/routes → app).',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#layer-imports',
    },
    schema: [
      {
        type: 'object',
        properties: {
          layers: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' }, minItems: 1 },
            minItems: 1,
            description: 'Folders under `src/`, lowest level first; folders in one inner array share a level.',
          },
          allowTypeImports: {
            type: 'boolean',
            description: 'Whether type-only imports may point at a higher layer (default true).',
          },
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
      upward:
        '`{{fromLayer}}` cannot import `{{specifier}}` from the higher layer `{{toLayer}}`. Layers import only their own level or below: {{order}}. Move the shared code down into a lower layer, or pass it in from above.',
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')
    const srcDir = srcDirOf(filename)

    if (srcDir === null || isTestFile(filename) || !isLayeredFile(filename, options.ignore ?? [])) {
      return {}
    }

    const layers = options.layers ?? DEFAULT_LAYERS
    const levels = levelIndex(layers)
    const fromLayer = fileDirsUnderSrc(filename, srcDir)[0]
    const fromLevel = fromLayer === undefined ? undefined : levels.get(fromLayer)

    // A file directly in `src/` (main.tsx) or in an unlisted folder has no level to compare against.
    if (fromLayer === undefined || fromLevel === undefined) {
      return {}
    }

    const allowTypeImports = options.allowTypeImports ?? true
    const rootAlias = options.rootAlias ?? DEFAULT_ROOT_ALIAS

    const check = (node: Rule.Node): void => {
      const source = readImportSource(node)

      if (source === null || (allowTypeImports && source.typeOnly)) {
        return
      }

      const toLayer = resolveUnderSrc(filename, srcDir, source.specifier, rootAlias)?.[0]
      const toLevel = toLayer === undefined ? undefined : levels.get(toLayer)

      if (toLevel === undefined || toLevel <= fromLevel) {
        return
      }

      context.report({
        node: source.node,
        messageId: 'upward',
        data: { fromLayer, toLayer: toLayer!, specifier: source.specifier, order: describeOrder(layers) },
      })
    }

    return Object.fromEntries(
      IMPORT_SELECTORS.map((selector) => {
        return [selector, check]
      }),
    )
  },
}
