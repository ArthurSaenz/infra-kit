import type { InfraKitPackageConfig } from '@slip-stream-kit/config'

/**
 * Audit POLICY: the baselines a package's `infra-kit.config.ts` is resolved against, and the merge
 * that resolves it.
 *
 * The config-authoring surface (`defineConfig`, the `InfraKit*` types, `packageConfigSchema`) lives in
 * `@slip-stream-kit/config` — a separate npm package a consumer installs locally. The baselines
 * deliberately did NOT move with it: they are decisions this CLI enforces, not a contract a consumer
 * authors against. Shipping them to consumers would freeze audit policy into their lockfiles and make
 * every rule change a coordinated release.
 */

/** Fully-resolved rules with every defaultable field present. */
export interface ResolvedPackageRules {
  requiredScripts: string[]
  requiredFiles: string[]
  turboTasks: string[]
}

/**
 * Baseline rules for a standard TypeScript workspace package, applied to any key
 * a package leaves unset. These are the "under the hood" defaults so a conforming
 * package's config can stay empty; non-standard packages override the relevant key.
 */
export const DEFAULT_RULES: Readonly<ResolvedPackageRules> = {
  requiredScripts: ['build', 'ts-check', 'eslint-check', 'prettier-check', 'test'],
  requiredFiles: ['tsconfig.json', 'eslint.config.js', 'readme.md'],
  turboTasks: [],
}

/**
 * The Playwright scripts every `e2e` package carries, value-exact — not merely present. The same
 * spelling in every repo is what lets `docs/e2e-playwright.md` and the generated CLAUDE.md block
 * describe one workflow, and a locally renamed or re-flagged script is exactly the drift they hide.
 * Not overridable from `infra-kit.config.ts` on purpose: a package that needs more adds scripts
 * beside these.
 */
/**
 * Per-action delay `e2e-test-ui-demo` runs with unless `E2E_SLOW_MO` is already set. Every other
 * script leaves the variable unset, which the configs read as 0. The e2e guidance block quotes this
 * number, so `bodies.test.ts` pins the two together.
 */
export const E2E_SLOW_MO_DEMO_MS = 2000

export const E2E_SCRIPTS: Readonly<Record<string, string>> = {
  'e2e-test': 'pnpm exec playwright test',
  'e2e-test-ui': 'pnpm exec playwright test --ui',
  'e2e-test-ui-demo': `E2E_SLOW_MO=\${E2E_SLOW_MO:-${E2E_SLOW_MO_DEMO_MS}} pnpm exec playwright test --ui --headed --workers=1`,
  'e2e-test-chrome': 'pnpm exec playwright test --project=chromium',
  'e2e-test-debug': 'pnpm exec playwright test --debug',
  'e2e-test-codegen': 'pnpm exec playwright codegen',
  'playwright-install': 'pnpm exec playwright install --with-deps',
}

/**
 * Baseline rules for the monorepo root (`infra-kit audit --root`). Checks the
 * root commands, the workspace/turbo files, and that the turbo pipeline defines
 * the expected tasks — so the root's own config can also stay empty.
 */
export const ROOT_DEFAULT_RULES: Readonly<ResolvedPackageRules> = {
  requiredScripts: ['build', 'dev', 'test', 'qa', 'infra-kit-check', 'fix'],
  requiredFiles: ['turbo.json', 'pnpm-workspace.yaml'],
  turboTasks: ['build', 'test', 'ts-check', 'eslint-check', 'prettier-check', 'infra-kit-check'],
}

/**
 * Merge a parsed package config over a baseline. Each key is replaced wholesale
 * when the package provides it, otherwise the baseline value is used.
 *
 * @example
 * resolvePackageConfig({ requiredScripts: [] })
 * // => { requiredScripts: [], requiredFiles: [...DEFAULT_RULES.requiredFiles], turboTasks: [] }
 */
export const resolvePackageConfig = (
  config: InfraKitPackageConfig,
  baseline: Readonly<ResolvedPackageRules> = DEFAULT_RULES,
): ResolvedPackageRules => {
  return {
    requiredScripts: config.requiredScripts ?? [...baseline.requiredScripts],
    requiredFiles: config.requiredFiles ?? [...baseline.requiredFiles],
    turboTasks: config.turbo?.requiredTasks ?? [...baseline.turboTasks],
  }
}
