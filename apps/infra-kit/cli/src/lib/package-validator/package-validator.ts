import path from 'node:path'

import { DEFAULT_RULES } from 'src/lib/package-config'
import type { ResolvedPackageRules } from 'src/lib/package-config'

import { checkConfig, checkFiles, checkScripts, checkTurbo } from './checks'
import { readPackageJson } from './loader'
import type { PackageCheck, PackageValidationResult } from './types'

// Re-exported on the historical import path so consumers and tests that reach
// for the loader through `package-validator` keep resolving after the split.
export { discoverPackages, loadPackageConfig } from './loader'
export type { PackageCheck, PackageValidationResult } from './types'

/**
 * Validate a single directory against its `infra-kit.config.ts` rules: the config
 * must be present and valid, every required script must be declared, every
 * required file must exist, and (root only) every required turbo task must be
 * defined. When the config fails to load, only that check is reported (the rules
 * are unknown, so the rule-based checks are skipped). `baseline` selects which
 * under-the-hood defaults apply — package defaults or {@link ROOT_DEFAULT_RULES}.
 *
 * @example
 * const result = await validatePackage('/repo/packages/serverless-config')
 * // result.passed reflects the package's conformance; result.checks lists each check
 */
export const validatePackage = async (
  packageDir: string,
  baseline: Readonly<ResolvedPackageRules> = DEFAULT_RULES,
): Promise<PackageValidationResult> => {
  const pkgJson = await readPackageJson(packageDir)
  const packageName = pkgJson.name ?? path.basename(packageDir)

  const { check: configCheck, rules } = await checkConfig(packageDir, baseline)
  const checks: PackageCheck[] = [configCheck]

  if (rules) {
    checks.push(...checkScripts(pkgJson.scripts ?? {}, rules.requiredScripts))
    checks.push(...(await checkFiles(packageDir, rules.requiredFiles)))
    checks.push(...(await checkTurbo(packageDir, rules.turboTasks)))
  }

  const passed = checks.every((check) => {
    return check.status === 'pass'
  })

  return { packageDir, packageName, checks, passed }
}
