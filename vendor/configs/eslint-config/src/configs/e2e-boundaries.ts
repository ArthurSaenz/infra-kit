import type { TypedFlatConfigItem } from '@antfu/eslint-config'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { ConfigRules } from '../types.js'

/**
 * Shared layers of a Playwright suite, bottom to top. A file imports from its own layer or any layer
 * below it.
 */
const LAYERS = ['config', 'lib', 'mocks', 'components', 'pages', 'fixtures'] as const

/** Top-level entry points: nothing imports them, and they may import every shared layer. */
const DOMAIN_ROOTS = ['tests', 'visual'] as const

const SOURCE_FILE = /\.(?:[cm]?[jt]s)$/

// Same signal as `@wl/package-structure` (@slip-stream-kit/config's DEPENDENCY_SIGNALS), which does
// not export its detector: the nearest package.json declares `@playwright/test`.
const E2E_DEPENDENCY = '@playwright/test'

const e2eByDir = new Map<string, boolean>()

const isE2ePackageDir = (dir: string): boolean => {
  const cached = e2eByDir.get(dir)

  if (cached !== undefined) return cached

  const manifest = path.join(dir, 'package.json')
  const parent = path.dirname(dir)
  let result: boolean

  if (existsSync(manifest)) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, Record<string, string> | undefined>

    result = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].some((deps) => {
      return deps?.[E2E_DEPENDENCY] !== undefined
    })
  } else {
    result = parent === dir ? false : isE2ePackageDir(parent)
  }

  e2eByDir.set(dir, result)

  return result
}

export const isE2eSourceFile = (filePath: string): boolean => {
  return SOURCE_FILE.test(filePath) && isE2ePackageDir(path.dirname(filePath))
}

const layersUpTo = (layer: (typeof LAYERS)[number]) => {
  return LAYERS.slice(0, LAYERS.indexOf(layer) + 1)
}

/**
 * Import direction for e2e packages, replacing the app-code classification (features / services /
 * shared) they do not have:
 *
 *   tests/<domain> | visual/<domain> | setup → fixtures → pages → components → mocks → lib → config
 *
 * A domain folder is private — its files import each other relatively and never reach a sibling
 * domain; anything two domains share moves down into a shared layer.
 *
 * @example
 * e2eBoundaries('warn') // advisory; `eslint --quiet` hides warnings entirely
 */
export const e2eBoundaries = (severity: 'warn' | 'error' = 'error'): TypedFlatConfigItem => ({
  // A function pattern: e2e-ness is a property of the owning package, not of any path glob — `pages`,
  // `lib` and `config` are ordinary folder names in app packages too. Not in `TypedFlatConfigItem`'s
  // `files` type, but `@eslint/config-array` has matched function patterns since flat config shipped.
  files: [isE2eSourceFile as unknown as string],
  settings: {
    'boundaries/elements': [
      ...DOMAIN_ROOTS.map((root) => {
        return { type: 'domain', pattern: `**/src/${root}/*`, capture: ['base', 'domain'] }
      }),
      { type: 'setup', pattern: '**/src/setup' },
      ...LAYERS.map((layer) => {
        return { type: layer, pattern: `**/src/${layer}` }
      }),
    ],
  },
  rules: {
    // A file outside every layer and domain folder — `src/constants.ts` included — would escape the policy below.
    'boundaries/no-unknown-files': severity,
    'boundaries/dependencies': [
      severity,
      {
        default: 'disallow',
        policies: [
          ...LAYERS.map((layer) => {
            return {
              from: { element: { type: layer } },
              allow: { to: { element: { types: { anyOf: layersUpTo(layer) } } } },
            }
          }),
          {
            from: { element: { type: 'setup' } },
            allow: { to: { element: { types: { anyOf: ['setup', ...LAYERS] } } } },
          },
          {
            from: { element: { type: 'domain' } },
            allow: {
              to: [
                { element: { types: { anyOf: LAYERS } } },
                { element: { type: 'domain', captured: { domain: '{{from.element.captured.domain}}' } } },
              ],
            },
          },
        ],
      },
    ],
  } as ConfigRules,
})
