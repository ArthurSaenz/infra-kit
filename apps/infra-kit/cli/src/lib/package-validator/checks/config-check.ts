import path from 'node:path'

import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { DEFAULT_RULES, ROOT_DEFAULT_RULES, resolvePackageConfig } from 'src/lib/package-config'
import type { ResolvedPackageRules } from 'src/lib/package-config'

import { pathExists } from '../fs-utils'
import { PACKAGE_CONFIG_FILE, loadPackageConfig } from '../loader'
import type { PackageCheck } from '../types'

/**
 * Build the "config present and valid" check, returning the resolved rules when
 * the load succeeds so the caller can run the rule-based checks against them.
 * When the config fails to load the rules are `null` and the caller skips the
 * rule-based checks (the expectations are unknown).
 */
export const checkConfig = async (
  packageDir: string,
  baseline: Readonly<ResolvedPackageRules> = DEFAULT_RULES,
): Promise<{ check: PackageCheck; rules: ResolvedPackageRules | null }> => {
  try {
    const rules = await loadPackageConfig(packageDir, baseline)

    return {
      check: { name: PACKAGE_CONFIG_FILE, status: 'pass', message: 'present and valid' },
      rules,
    }
  } catch (err) {
    return {
      check: { name: PACKAGE_CONFIG_FILE, status: 'fail', message: (err as Error).message },
      rules: null,
    }
  }
}

const ROOT_CONFIG_CHECK = 'infra-kit.json'

/** The row a leftover root `infra-kit.config.ts` produces, or `null` when the root is clean. */
const checkRetiredRootConfig = async (rootDir: string): Promise<PackageCheck | null> => {
  if (!(await pathExists(path.join(rootDir, PACKAGE_CONFIG_FILE)))) return null

  return {
    name: PACKAGE_CONFIG_FILE,
    status: 'fail',
    message: `retired at the repo root — root audit rules live in infra-kit.json "audit". Run \`infra-kit audit --fix --root\` to move them and delete the file`,
  }
}

/**
 * The root counterpart of {@link checkConfig}: `audit --root` rules come from the project
 * `infra-kit.json` `audit` block, resolved over `baseline`. A root `infra-kit.config.ts` is the
 * retired home of those rules, so its presence fails rather than being read.
 */
export const checkRootConfig = async (
  rootDir: string,
  baseline: Readonly<ResolvedPackageRules> = ROOT_DEFAULT_RULES,
): Promise<{ checks: PackageCheck[]; rules: ResolvedPackageRules | null }> => {
  const retired = await checkRetiredRootConfig(rootDir)
  const extra = retired ? [retired] : []

  try {
    const { audit = {} } = await getInfraKitConfig()

    return {
      checks: [{ name: ROOT_CONFIG_CHECK, status: 'pass', message: 'present and valid' }, ...extra],
      rules: resolvePackageConfig(audit, baseline),
    }
  } catch (err) {
    return {
      checks: [{ name: ROOT_CONFIG_CHECK, status: 'fail', message: (err as Error).message }, ...extra],
      rules: null,
    }
  }
}
