import type { Rule } from 'eslint'

import { fileDirsUnderSrc, srcDirOf } from '../../utils/import-target'
import { findPackageRoot } from '../../utils/package-root'
import { resolvePackageType } from '../../utils/package-type-reader'
import { matchesAnyGlob } from '../../utils/path-match'

export interface Options {
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

const INDEX_FILE = /\/index\.[cm]?[jt]sx?$/

const camelCase = (kebab: string): string => {
  return kebab
    .split('-')
    .map((part, index) => {
      return index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join('')
}

interface PublicApi {
  messageId: 'featureExportAll' | 'domainExportAll'
  name: string
}

/** The feature or backend domain whose public API `filename` is, or null for any other file. */
const publicApiOf = (filename: string, srcDir: string): PublicApi | null => {
  const dirs = fileDirsUnderSrc(filename, srcDir)

  if (dirs.length !== 2 || !INDEX_FILE.test(filename)) {
    return null
  }

  const packageRoot = findPackageRoot(filename)
  const type = packageRoot === null ? null : resolvePackageType(packageRoot)
  const [layer, name] = dirs as [string, string]

  if (type === 'backend') {
    return layer === 'services' ? { messageId: 'domainExportAll', name } : null
  }

  return layer === 'features' && type !== 'e2e' ? { messageId: 'featureExportAll', name } : null
}

interface ExportAllNode {
  exported: unknown
  exportKind?: string
  source: { value: unknown }
}

export const noPublicApiExportAll: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid `export * from` in the `index.ts` of a feature or a backend service domain: a public API names what it exports.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#no-public-api-export-all',
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
      featureExportAll:
        "`export * from '{{source}}'` makes every export of that module part of the public API of feature `{{name}}`. Name the exports (`export { A } from '{{source}}'`), or publish the module under one name (`export * as {{binding}}Service from '{{source}}'`). See /infra-kit:fe-architect for the feature public API.",
      domainExportAll:
        "`export * from '{{source}}'` makes every export of that module part of the public API of domain `{{name}}`. Name the exports (`export { A } from '{{source}}'`), or publish the module under one name (`export * as {{binding}} from '{{source}}'`). See /infra-kit:be-architect for the backend service layout.",
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')
    const ignore = options.ignore ?? []
    const srcDir = srcDirOf(filename)

    if (srcDir === null || (ignore.length > 0 && matchesAnyGlob(filename, ignore))) {
      return {}
    }

    const publicApi = publicApiOf(filename, srcDir)

    if (publicApi === null) {
      return {}
    }

    return {
      ExportAllDeclaration: (node: Rule.Node) => {
        const { exported, exportKind, source } = node as unknown as ExportAllNode

        // `export type *` is erased at build time, and `types.ts` is public by convention.
        if (exported !== null || exportKind === 'type') {
          return
        }

        context.report({
          node,
          messageId: publicApi.messageId,
          data: { name: publicApi.name, binding: camelCase(publicApi.name), source: String(source.value) },
        })
      },
    }
  },
}
