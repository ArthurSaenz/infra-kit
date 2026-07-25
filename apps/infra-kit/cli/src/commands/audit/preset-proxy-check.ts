/**
 * Root-audit checks for `devServersPresets`: target-key grammar, then proxy locality.
 *
 * Bridges the impure world (project config + discovery + each frontend's loaded
 * `infra-kit.config.ts`) to the pure {@link validatePresetKeys} / {@link validatePresetProxy}
 * rules, then shapes the result as a {@link PackageValidationResult} so it slots into the
 * existing `infra-kit audit --root` output. Skipped (returns null) when the project declares
 * no `devServersPresets`.
 */
import { discoverApiApps, discoverUiApps } from 'src/dev/discovery'
import { buildPresetProxyContext } from 'src/dev/preset-proxy-context'
import type { LoadError } from 'src/dev/preset-proxy-context'
import { validatePresetKeys, validatePresetProxy } from 'src/dev/presets'
import type { DiscoveredParts } from 'src/dev/presets'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import type { PackageCheck, PackageValidationResult } from 'src/lib/package-validator'

/** Shape validator issues + config load errors into audit check lines (fail-only; caller adds the pass line). */
const toFailChecks = (issues: ReturnType<typeof validatePresetProxy>, loadErrors: LoadError[]): PackageCheck[] => {
  return [
    ...loadErrors.map((error): PackageCheck => {
      return {
        name: `devServersPresets:config:${error.app}`,
        status: 'fail',
        message: `could not load apps/${error.app}/ui/infra-kit.config.ts (referenced by a preset proxy override): ${error.message}`,
      }
    }),
    ...issues.map((issue): PackageCheck => {
      return { name: `devServersPresets:${issue.preset}`, status: 'fail', message: issue.message }
    }),
  ]
}

/**
 * Run the `devServersPresets` audit for the monorepo root: first the target-key grammar
 * (every key must name an `<app>/api` or `<app>/ui` package), then proxy locality. Returns
 * a synthetic `devServersPresets` validation result (one pass line, or one fail line per
 * bad key / violation / unloadable referenced config), or null when there are no presets
 * to check.
 *
 * @example
 * const result = await checkDevPresets('/repo')
 * // result?.checks[0] => { name: 'devServersPresets:proxy-locality', status: 'pass', message: '…' }
 */
export const checkDevPresets = async (root: string): Promise<PackageValidationResult | null> => {
  const presets = (await getInfraKitConfig()).devServersPresets

  if (!presets || Object.keys(presets).length === 0) {
    return null
  }

  // Grammar first: an unparseable target key makes `resolvePreset` throw, so it has to
  // surface as an audit line here rather than crash every check below it.
  const keyIssues = validatePresetKeys(presets)

  if (keyIssues.length > 0) {
    const checks = keyIssues.map((issue): PackageCheck => {
      return { name: `devServersPresets:${issue.preset}`, status: 'fail', message: issue.message }
    })

    return { packageDir: root, packageName: 'devServersPresets', checks, passed: false }
  }

  const apiApps = discoverApiApps(root)
  const uiApps = discoverUiApps(root)
  const discovered: DiscoveredParts = {
    api: apiApps.map((a) => {
      return a.name
    }),
    ui: uiApps.map((a) => {
      return a.name
    }),
  }

  const { ctx, loadErrors } = await buildPresetProxyContext(root, presets, discovered, apiApps)

  const failChecks = toFailChecks(validatePresetProxy(presets, ctx), loadErrors)

  const checks: PackageCheck[] =
    failChecks.length === 0
      ? [
          {
            name: 'devServersPresets:proxy-locality',
            status: 'pass',
            message: 'every local proxy override resolves to a backend the preset launches',
          },
        ]
      : failChecks

  return { packageDir: root, packageName: 'devServersPresets', checks, passed: failChecks.length === 0 }
}
