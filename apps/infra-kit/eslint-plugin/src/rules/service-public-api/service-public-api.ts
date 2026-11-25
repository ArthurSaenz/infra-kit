import type { Rule } from 'eslint'

import type { ImportSource } from '../../utils/import-target'
import {
  DEFAULT_ROOT_ALIAS,
  IMPORT_SELECTORS,
  fileDirsUnderSrc,
  isFeaturePublicApi,
  readImportSource,
  resolveUnderSrc,
  srcDirOf,
} from '../../utils/import-target'
import { findPackageRoot } from '../../utils/package-root'
import { resolvePackageType } from '../../utils/package-type-reader'
import { matchesAnyGlob } from '../../utils/path-match'

export interface Options {
  /** The alias that maps to the package's `src/`. */
  rootAlias?: string
  /** Globs of `src/lib/**` files allowed to import services at runtime (composition roots). */
  libRuntimeAllow?: string[]
  /** Globs; the rule is skipped for matching files. */
  ignore?: string[]
}

const SERVICES = 'services'
const LIB = 'lib'
const SEE_SKILL = ' See /infra-kit:be-architect for the backend import rules.'

/** The domain a src-relative path sits in (`services/<domain>/…`), or null outside a domain. */
const domainOf = (segments: readonly string[]): string | null => {
  return segments[0] === SERVICES && segments.length >= 2 ? segments[1]! : null
}

interface ImportEqualsNode {
  importKind?: string
  moduleReference: { type: string; expression?: { type: string; value?: unknown } }
}

/** `import x = require('…')`: the one module-naming node `readImportSource` does not cover. */
const readImportEqualsSource = (node: Rule.Node): ImportSource | null => {
  const { importKind, moduleReference } = node as unknown as ImportEqualsNode
  const literal = moduleReference.type === 'TSExternalModuleReference' ? moduleReference.expression : undefined

  if (literal?.type !== 'Literal' || typeof literal.value !== 'string') {
    return null
  }

  return { specifier: literal.value, node: literal as unknown as Rule.Node, typeOnly: importKind === 'type' }
}

export const servicePublicApi: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require backend code to enter a service domain only through its `index.ts`, and forbid runtime imports between domains and from `src/lib/` into services.',
      recommended: true,
      url: 'https://github.com/ArthurSaenz/infra-kit/tree/main/apps/infra-kit/eslint-plugin#service-public-api',
    },
    schema: [
      {
        type: 'object',
        properties: {
          rootAlias: { type: 'string', description: 'The alias that maps to `src/` (default `#root`).' },
          libRuntimeAllow: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional globs of `src/lib/**` files allowed to import services at runtime.',
          },
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
      deepImport: `\`{{specifier}}\` reaches into the internals of domain \`{{domain}}\`. Import from its public API \`{{publicApi}}\` instead, exporting what you need from \`services/{{domain}}/index.ts\`.${SEE_SKILL}`,
      crossDomainRuntime: `\`{{specifier}}\` imports domain \`{{domain}}\` at runtime from domain \`{{ownDomain}}\`. Domains share only types (\`import type\`); compose services in a controller instead.${SEE_SKILL}`,
      libRuntimeImport: `\`{{specifier}}\` imports domain \`{{domain}}\` at runtime from \`src/lib/\`, which must stay domain-free. Move the code into the domain, or import only types (\`import type\`).${SEE_SKILL}`,
    },
  },

  create(context) {
    const options = (context.options[0] ?? {}) as Options
    const filename = context.filename.split('\\').join('/')
    const ignore = options.ignore ?? []

    if (ignore.length > 0 && matchesAnyGlob(filename, ignore)) {
      return {}
    }

    const packageRoot = findPackageRoot(filename)
    const srcDir = srcDirOf(filename)

    if (packageRoot === null || srcDir === null || resolvePackageType(packageRoot) !== 'backend') {
      return {}
    }

    const rootAlias = options.rootAlias ?? DEFAULT_ROOT_ALIAS
    const dirs = fileDirsUnderSrc(filename, srcDir)
    const ownDomain = domainOf(dirs)
    const libRuntimeAllow = options.libRuntimeAllow ?? []

    const isGuardedLibFile =
      dirs[0] === LIB && !(libRuntimeAllow.length > 0 && matchesAnyGlob(filename, libRuntimeAllow))

    const check = (source: ImportSource | null): void => {
      const target = source === null ? null : resolveUnderSrc(filename, srcDir, source.specifier, rootAlias)
      const domain = target === null ? null : domainOf(target)

      if (source === null || domain === null || domain === ownDomain) {
        return
      }

      const data = {
        specifier: source.specifier,
        domain,
        ownDomain: ownDomain ?? '',
        publicApi: `${rootAlias}/${SERVICES}/${domain}`,
      }

      if (!isFeaturePublicApi(target!)) {
        context.report({ node: source.node, messageId: 'deepImport', data })
      }

      if (source.typeOnly) {
        return
      }

      if (ownDomain !== null) {
        context.report({ node: source.node, messageId: 'crossDomainRuntime', data })
      } else if (isGuardedLibFile) {
        context.report({ node: source.node, messageId: 'libRuntimeImport', data })
      }
    }

    return {
      ...Object.fromEntries(
        IMPORT_SELECTORS.map((selector) => {
          return [
            selector,
            (node: Rule.Node) => {
              check(readImportSource(node))
            },
          ]
        }),
      ),
      TSImportEqualsDeclaration: (node: Rule.Node) => {
        check(readImportEqualsSource(node))
      },
    }
  },
}
