import process from 'node:process'
import { z } from 'zod'

import { findWorkspaceRoot, resolveAdoption } from 'src/lib/agent-guidance'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { ROOT_DEFAULT_RULES } from 'src/lib/package-config'
import type { ResolvedPackageRules } from 'src/lib/package-config'
import { discoverPackages, validatePackage } from 'src/lib/package-validator'
import type { PackageValidationResult } from 'src/lib/package-validator'
import { findPackageRoot } from 'src/lib/package-validator/loader'
import { defineMcpTool, textContent } from 'src/types'

import { runAuditFix } from './fix'
import type { FixedEntry } from './fix'
import { checkDevPresets } from './preset-proxy-check'

// TODO [DO]: extract `audit` into its own standalone CLI tool, decoupled from infra-kit.

interface AuditOptions {
  /** Audit every non-vendor workspace package instead of just the current one. */
  all?: boolean
  /** Audit the monorepo root (turbo pipeline + root commands) instead of a package. */
  root?: boolean
  /** Directory to resolve the current package from. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Write the guidance block for the audited scope BEFORE checking it. CLI-only — the MCP
   * input schema has no `fix` key, so an agent cannot reach this (see `auditMcpTool`).
   */
  fix?: boolean
  /** With `fix`: scaffold `DESIGN.md` for `frontend`/`mobile` packages that lack one. CLI-only. */
  design?: boolean
}

/** The payload `audit()` returns, and the CLI action reads its exit code out of. */
interface AuditStructuredContent {
  allPassed: boolean
  packages: { name: string; passed: boolean; checks: PackageValidationResult['checks'] }[]
  /**
   * Present only on a `--fix` run, which is why it is optional rather than conditionally
   * spread: `program.ts` destructures it, so the property has to exist on the type even
   * though it is absent from every response an MCP client can elicit.
   */
  fixed?: FixedEntry[]
}

/**
 * Printed when a single-package fix flips the workspace into adoption. From that moment every
 * OTHER package's `missing` block stops passing, so the run that caused it has to say so.
 */
const ADOPTION_FLIP_LINE =
  'workspace adopted — every other package now needs a CLAUDE.md: run infra-kit audit --fix --all'

/** A directory to audit plus the under-the-hood defaults that apply to it. */
interface AuditTarget {
  dir: string
  baseline?: Readonly<ResolvedPackageRules>
  /**
   * The monorepo root rather than a package. Carried so `validatePackage` can skip the
   * package-scoped `agent-guidance` check: the root `CLAUDE.md` holds the root marker pair.
   */
  isRoot?: boolean
}

/**
 * Resolve which directories to audit, and the baseline defaults each uses:
 * `root` → the monorepo root with {@link ROOT_DEFAULT_RULES}; `all` → every
 * discovered non-vendor package; otherwise the package walked up from cwd.
 */
const resolveTargets = async (options: AuditOptions): Promise<AuditTarget[]> => {
  if (options.root) {
    return [{ dir: await getProjectRoot(), baseline: ROOT_DEFAULT_RULES, isRoot: true }]
  }

  if (options.all) {
    const dirs = await discoverPackages(await getProjectRoot())

    return dirs.map((dir) => {
      return { dir }
    })
  }

  return [{ dir: await findPackageRoot(options.cwd ?? process.cwd()) }]
}

/**
 * Where the workspace-root walk starts. Repo-wide runs (`--root`, `--all`) already know the
 * project root; a per-package run — the `infra-kit-check` shape turbo runs once per package —
 * starts at its own directory and walks up to `pnpm-workspace.yaml`. Adoption is a property
 * of the workspace, so both shapes must reach the same verdict.
 */
const resolveAdoptionStart = async (options: AuditOptions): Promise<string> => {
  return options.root || options.all ? await getProjectRoot() : (options.cwd ?? process.cwd())
}

/**
 * Print the audit outcome. Passing checks collapse into the summary line — only
 * failures print detail — so a green audit costs one line instead of one per
 * check (this output is read by CI logs and agent loops, where every line is
 * tokens). Returns whether every check passed.
 *
 * @example
 * // green:  ✅ audit passed — 8 checks, 2 targets
 * // red:    [FAIL] travelist-monorepo turbo:test: not defined in turbo.json
 * //         ❌ audit failed — 1/8 checks, 2 targets
 */
const logResults = (results: PackageValidationResult[]): boolean => {
  let total = 0
  let failed = 0

  for (const result of results) {
    for (const check of result.checks) {
      total += 1

      if (check.status !== 'pass') {
        failed += 1

        logger.info(`[FAIL] ${result.packageName} ${check.name}: ${check.message}`)
      }
    }
  }

  const allPassed = results.every((result) => {
    return result.passed
  })

  const plural = (count: number, noun: string): string => {
    return `${count} ${noun}${count === 1 ? '' : 's'}`
  }

  const scope = `${plural(total, 'check')}, ${plural(results.length, 'target')}`

  logger.info(allPassed ? `✅ audit passed — ${scope}` : `❌ audit failed — ${failed}/${scope}`)

  return allPassed
}

/**
 * Run the CLI-only `--fix` branch and print the adoption-flip line when the run switched
 * enforcement on. Returns the entries `audit()` publishes as `structuredContent.fixed`.
 */
const applyFix = async (options: AuditOptions, workspaceRoot: string | null): Promise<FixedEntry[]> => {
  const { fixed, adoptionFlipped } = await runAuditFix(options, workspaceRoot)

  if (adoptionFlipped) logger.info(ADOPTION_FLIP_LINE)

  return fixed
}

/**
 * Audit the monorepo root (`root`), every non-vendor workspace package (`all`),
 * or the package resolved by walking up from the working directory (default —
 * the shape used by a package's `"infra-kit-check": "pnpm exec infra-kit audit"` script). The
 * returned `structuredContent.allPassed` lets the CLI set a non-zero exit code so
 * the audit fails CI; this function never calls `process.exit` so the MCP tool
 * can reuse it.
 *
 * @example
 * // CLI inside packages/serverless-config: `infra-kit audit`
 * await audit()              // audits the current package
 * await audit({ all: true }) // audits every non-vendor workspace package
 * await audit({ root: true }) // audits the monorepo root (turbo + root commands)
 */
export const audit = async (options: AuditOptions = {}) => {
  const workspaceRoot = findWorkspaceRoot(await resolveAdoptionStart(options))
  // Fix first, check second — the `eslint --fix` model. `runAuditFix` re-probes adoption after
  // writing, so the `resolveAdoption` below sees the files this run just created.
  const fixed = options.fix ? await applyFix(options, workspaceRoot) : undefined
  const targets = await resolveTargets(options)
  const adoption = await resolveAdoption(workspaceRoot)

  const results: PackageValidationResult[] = []

  for (const target of targets) {
    results.push(await validatePackage(target.dir, target.baseline, { adoption, isRoot: target.isRoot }))
  }

  // Root audit also validates project-level devServersPresets proxy locality (a `local`
  // route override must have its backend launched by the preset). Skipped when the
  // project declares no presets. Only meaningful at the root — presets live in the
  // project infra-kit.json, not in any single package.
  if (options.root) {
    const presetResult = await checkDevPresets(targets[0]!.dir)

    if (presetResult) {
      results.push(presetResult)
    }
  }

  const allPassed = logResults(results)

  const structuredContent: AuditStructuredContent = {
    allPassed,
    packages: results.map((result) => {
      return {
        name: result.packageName,
        passed: result.passed,
        checks: result.checks,
      }
    }),
  }

  // Assigned rather than spread so the key is ABSENT on a non-fix run: `outputSchema` does not
  // document `fixed`, and it stays accurate for every response an MCP client can elicit only
  // while no MCP-reachable call produces one.
  if (fixed) structuredContent.fixed = fixed

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

const auditInputSchema = {
  all: z.boolean().optional().describe('Audit every non-vendor workspace package'),
  root: z.boolean().optional().describe('Audit the monorepo root (turbo pipeline + root commands)'),
}

const auditOutputSchema = {
  allPassed: z.boolean().describe('Whether every audited package passed all checks'),
  packages: z
    .array(
      z.object({
        name: z.string(),
        passed: z.boolean(),
        checks: z.array(
          z.object({
            name: z.string(),
            status: z.enum(['pass', 'fail']),
            message: z.string(),
          }),
        ),
      }),
    )
    .describe('Per-package check results'),
}

// MCP Tool Registration
export const auditMcpTool = defineMcpTool({
  name: 'audit',
  description:
    'Audit packages against infra-kit.config.ts rules (config present and valid, required scripts, required files, and turbo tasks for the root). Defaults to the current package; all=true audits every non-vendor workspace package; root=true audits the monorepo root.',
  inputSchema: auditInputSchema,
  outputSchema: auditOutputSchema,
  // Read-only on purpose: `--fix` and `--design` are NOT reachable here. The MCP boundary
  // auto-confirms every tool call, so a flag that writes into the repo must never be one
  // `handler: audit` away from an agent invoking it.
  //
  // The catalog's `mutating: false` for `audit` stays accurate ONLY while this handler forwards
  // `params.all` / `params.root` BY FIELD and `auditInputSchema` carries no `fix` key. Either a
  // bare `handler: audit` or a `fix` key added to the schema would make the tool mutating while
  // `command-catalog.test.ts`'s fail-closed ungated-mutating gate stayed green — that gate reads
  // the catalog's `mutating` flag, which nothing recomputes from this handler.
  handler: (params) => {
    return audit({ all: params.all, root: params.root })
  },
})
