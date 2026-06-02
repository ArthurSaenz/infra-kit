import { DEFAULT_RULES } from 'src/lib/package-config'
import type { ResolvedPackageRules } from 'src/lib/package-config'

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
