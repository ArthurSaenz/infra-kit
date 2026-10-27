import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { DEFAULT_RULES, ROOT_DEFAULT_RULES } from 'src/lib/package-config'
import type { ResolvedPackageRules } from 'src/lib/package-config'
import type { PackageCheck } from 'src/lib/package-validator'
import { loadAuthoredPackageConfig } from 'src/lib/package-validator/loader'

const EMPTY_RULES_CHECK = 'empty-rules'

type RuleKey = 'requiredScripts' | 'requiredFiles'

const RULE_KEYS: readonly RuleKey[] = ['requiredScripts', 'requiredFiles']

/**
 * An explicit `[]` replaces the defaults wholesale (see `resolvePackageConfig`), so it switches the
 * check off rather than relaxing it — which is how every consumer silenced audit "temporarily".
 * An absent key inherits the defaults and is never reported.
 *
 * @example
 * findEmptyRules({ requiredScripts: [] }, DEFAULT_RULES, 'infra-kit.config.ts')
 * // => [{ name: 'empty-rules', status: 'warn', message: 'infra-kit.config.ts sets requiredScripts: [] …' }]
 */
export const findEmptyRules = (
  authored: Partial<Record<RuleKey, readonly string[]>>,
  baseline: Readonly<ResolvedPackageRules>,
  source: string,
): PackageCheck[] => {
  return RULE_KEYS.filter((key) => {
    return authored[key]?.length === 0
  }).map((key): PackageCheck => {
    return {
      name: EMPTY_RULES_CHECK,
      status: 'warn',
      message: `${source} sets ${key}: [], which disables the check instead of relaxing it — delete the key to inherit the defaults (${baseline[key].join(', ')}), or list what this target really has`,
    }
  })
}

/**
 * Empty overrides in one audit target's authored rules. A config that fails to load yields nothing:
 * the `infra-kit.config.ts` / `infra-kit.json` row already fails on it.
 */
export const checkEmptyRules = async (dir: string, isRoot: boolean): Promise<PackageCheck[]> => {
  try {
    if (isRoot) {
      const { audit = {} } = await getInfraKitConfig()

      return findEmptyRules(audit, ROOT_DEFAULT_RULES, 'infra-kit.json "audit"')
    }

    return findEmptyRules((await loadAuthoredPackageConfig(dir)) ?? {}, DEFAULT_RULES, 'infra-kit.config.ts')
  } catch {
    return []
  }
}
