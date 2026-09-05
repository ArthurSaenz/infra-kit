import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type ViteUserConfig, mergeConfig } from 'vitest/config'

/**
 * Shared Vitest configuration for every package in the monorepo.
 *
 * Each package owns a `vitest.config.ts` that calls one of these factories with its own
 * `import.meta.dirname` and merges in whatever is genuinely package-specific. Anything that
 * belongs to all packages of a kind lives here, so a Vitest major is a change in one file.
 */

const EXCLUDE = ['**/node_modules/**', '**/dist/**']

/**
 * Vitest resolves a relative `setupFiles` entry against the project root, but resolving it here
 * keeps the path correct no matter which directory the runner was invoked from. Not every package
 * has a setup file, so its presence on disk is what decides whether one is wired up.
 */
const setupFilesFor = (dirname: string): string[] => {
  const setupFile = resolve(dirname, 'vitest.setup.ts')

  return existsSync(setupFile) ? [setupFile] : []
}

const rootAliasFor = (dirname: string) => ({
  '#root': resolve(dirname, 'src'),
})

/** Node-environment tests: services, transforms, schemas — everything without a DOM. */
export const defineNodeConfig = (dirname: string, overrides: ViteUserConfig = {}): ViteUserConfig =>
  mergeConfig(
    {
      resolve: {
        alias: rootAliasFor(dirname),
      },
      test: {
        environment: 'node',
        exclude: EXCLUDE,
        setupFiles: setupFilesFor(dirname),
        // NOTE: do not enable `fsModuleCache` here. Its hash covers file content, module id and
        // the Vite env config — not the built `dist/` of this package. Every vendor sync rebuilds
        // that dist out of band, and the stale cache then fails every file in a project with a
        // misleading "Cannot read properties of undefined (reading 'config')" and "no tests".
      },
    },
    overrides,
  )

/**
 * Browser-mode tests without a framework plugin. Use this only for non-React packages
 * (they supply their own plugin via `overrides`); React packages want `defineReactBrowserConfig`.
 */
export const defineBrowserConfig = (dirname: string, overrides: ViteUserConfig = {}): ViteUserConfig =>
  mergeConfig(
    {
      resolve: {
        alias: rootAliasFor(dirname),
      },
      test: {
        exclude: EXCLUDE,
        setupFiles: setupFilesFor(dirname),
        browser: {
          enabled: true,
          provider: playwright(),
          instances: [{ browser: 'chromium' }],
          headless: true,
        },
      },
    },
    overrides,
  )

/** Browser-mode tests for React packages, rendered through `vitest-browser-react`. */
export const defineReactBrowserConfig = (dirname: string, overrides: ViteUserConfig = {}): ViteUserConfig =>
  mergeConfig(
    defineBrowserConfig(dirname, {
      // The plugin's own Vite version can differ from the workspace one, which makes the
      // structurally identical Plugin types incompatible.
      plugins: [react() as never],
      resolve: {
        // Without this, Vite pre-bundles `radix-ui` and `vitest-browser-react` into separate dep
        // chunks that each resolve their own React, so any test rendering a Radix primitive dies
        // on `Cannot read properties of null (reading 'useRef')`.
        dedupe: ['react', 'react-dom'],
      },
    }),
    overrides,
  )
