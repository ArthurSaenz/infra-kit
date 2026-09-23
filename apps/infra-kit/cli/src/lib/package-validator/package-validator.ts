import path from 'node:path'

import type { AdoptionState } from 'src/lib/agent-guidance/adoption'
import { detectPackageType } from 'src/lib/agent-guidance/package-type'
import { DEFAULT_RULES } from 'src/lib/package-config'
import type { ResolvedPackageRules } from 'src/lib/package-config'

import { checkAgentGuidance, checkConfig, checkE2e, checkFiles, checkScripts, checkTurbo } from './checks'
import { readDeclaredPackageType, readPackageJson } from './loader'
import type { PackageCheck, PackageValidationResult } from './types'

// Re-exported on the historical import path so consumers and tests that reach
// for the loader through `package-validator` keep resolving after the split.
export { discoverPackages, loadPackageConfig } from './loader'
export type { PackageCheck, PackageValidationResult } from './types'

/** Caller-supplied context for one {@link validatePackage} run. */
export interface ValidatePackageOptions {
  /**
   * Whether the enclosing workspace has adopted per-package guidance blocks, and the
   * evidence for it. Absent means "not adopted" — the eight existing call sites pass no
   * options, and an un-probed workspace must never enforce.
   */
  adoption?: AdoptionState
  /**
   * Set for the monorepo root. The root `CLAUDE.md` carries the *root* marker pair, so the
   * package-scoped `agent-guidance` check would resolve it to `foreign-block` and fail every
   * consumer's `infra-kit-check-root`. The check is skipped entirely instead.
   */
  isRoot?: boolean
  /**
   * Repo root, so the package type can be inferred from the path (`apps/<app>/tests` → e2e) the
   * same way the guidance writer infers it. Absent, only a declared `type` or a dependency signal counts.
   */
  repoRoot?: string
}

/** What an absent `adoption` option means: never enforce on a workspace nobody probed. */
const UNADOPTED: AdoptionState = { adopted: false, workspaceRoot: null }

const resolvePackageType = async (
  packageDir: string,
  pkgJson: Awaited<ReturnType<typeof readPackageJson>>,
  repoRoot: string | undefined,
) => {
  return detectPackageType({
    packageDir,
    repoRoot: repoRoot ?? packageDir,
    pkgJson,
    declaredType: await readDeclaredPackageType(packageDir),
  })
}

/**
 * Validate a single directory against its `infra-kit.config.ts` rules: the config
 * must be present and valid, every required script must be declared, every
 * required file must exist, and (root only) every required turbo task must be
 * defined. When the config fails to load, the rule-based checks are skipped (the
 * rules are unknown) but the `agent-guidance` check still reports, since it reads
 * `CLAUDE.md` rather than the rules. `baseline` selects which under-the-hood
 * defaults apply — package defaults or {@link ROOT_DEFAULT_RULES}.
 *
 * @example
 * const result = await validatePackage('/repo/packages/serverless-config')
 * // result.passed reflects the package's conformance; result.checks lists each check
 * @example
 * // From `audit`, with the workspace adoption state threaded in:
 * await validatePackage(dir, DEFAULT_RULES, { adoption, isRoot: false })
 */
export const validatePackage = async (
  packageDir: string,
  baseline: Readonly<ResolvedPackageRules> = DEFAULT_RULES,
  options: ValidatePackageOptions = {},
): Promise<PackageValidationResult> => {
  const pkgJson = await readPackageJson(packageDir)
  const packageName = pkgJson.name ?? path.basename(packageDir)

  const { check: configCheck, rules } = await checkConfig(packageDir, baseline)
  const checks: PackageCheck[] = [configCheck]

  // Outside the `if (rules)` branch on purpose: a package whose config fails to load still
  // gets its guidance reported. Deliberately not a `requiredFiles` entry either — both
  // consumers override `requiredFiles` wholesale, which would make the rule silently inert.
  if (!options.isRoot) {
    checks.push(checkAgentGuidance(packageDir, options.adoption ?? UNADOPTED))
  }

  if (rules) {
    checks.push(...checkScripts(pkgJson.scripts ?? {}, rules.requiredScripts))
    checks.push(...(await checkFiles(packageDir, rules.requiredFiles)))
    checks.push(...(await checkTurbo(packageDir, rules.turboTasks)))
  }

  // Type-level policy, deliberately outside `rules`: a package cannot opt out of the shared e2e
  // convention by emptying `requiredScripts`, which every consumer did while the checks were "temporarily" off.
  if (!options.isRoot && (await resolvePackageType(packageDir, pkgJson, options.repoRoot)) === 'e2e') {
    checks.push(...(await checkE2e(packageDir, pkgJson.scripts ?? {})))
  }

  const passed = checks.every((check) => {
    return check.status === 'pass'
  })

  return { packageDir, packageName, checks, passed }
}
