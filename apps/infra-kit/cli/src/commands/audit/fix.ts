import path from 'node:path'
import process from 'node:process'

import { resetAdoptionCache, resolveAdoption, syncPackageGuidance, syncRootGuidance } from 'src/lib/agent-guidance'
import type { GuidanceWrite, PackageType, WriteAction } from 'src/lib/agent-guidance'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
// Deep loader path, NOT the `src/lib/package-validator` barrel: that barrel reaches
// `checks/index` → `agent-guidance-check` → `lib/agent-guidance`, and this module already
// imports that subtree. The loader imports nothing from `agent-guidance`, so this edge is safe.
import { discoverPackages, findPackageRoot, readDeclaredPackageType } from 'src/lib/package-validator/loader'

import packageJson from '../../../package.json' with { type: 'json' }

/**
 * One file a `--fix` run touched, as it appears in `audit()`'s
 * `structuredContent.fixed`. Deliberately narrower than {@link GuidanceWrite}:
 * the failure `message` is logged rather than published, so the shape stays the
 * `{ path, action, type }` triple the plan documents.
 */
export interface FixedEntry {
  /** Absolute path of the file. */
  path: string
  action: WriteAction
  /** Resolved package type; absent for the repo-root files. */
  type?: PackageType
}

/** The CLI-only options that reach the `--fix` branch. Mirrors `audit`'s own scope flags. */
export interface AuditFixOptions {
  /** Fix every discovered workspace package — packages only, never the root. */
  all?: boolean
  /** Fix the repo-root block only. */
  root?: boolean
  /** Scaffold `DESIGN.md` for `frontend`/`mobile` packages that lack one. */
  design?: boolean
  /** Directory the cwd-scoped package is resolved from. Defaults to `process.cwd()`. */
  cwd?: string
}

export interface AuditFixResult {
  fixed: FixedEntry[]
  /**
   * Whether this run switched the workspace from unadopted to adopted. Only ever true for a
   * single-package fix: an `--all` run leaves no package behind, so nothing starts failing.
   */
  adoptionFlipped: boolean
}

/** Action counts printed unconditionally, so a fully idempotent run still reports its scope. */
const ALWAYS_COUNTED: readonly WriteAction[] = ['unchanged', 'created']

/** Every action, in the order the summary line names them. */
const COUNT_ORDER: readonly WriteAction[] = ['unchanged', 'created', 'updated', 'removed', 'failed']

/**
 * Sync one workspace package, resolving its declared type first.
 *
 * `readDeclaredPackageType` is total by contract — an absent, unloadable or unrecognised
 * config resolves to `undefined` rather than rejecting — so a package whose config throws at
 * module scope degrades to detection instead of taking a whole `--all` run down with it.
 */
const syncOnePackage = async (
  packageDir: string,
  repoRoot: string,
  design: boolean | undefined,
): Promise<GuidanceWrite[]> => {
  const declaredType = await readDeclaredPackageType(packageDir)

  return syncPackageGuidance(packageDir, { repoRoot, version: packageJson.version, design, declaredType })
}

/**
 * Run the sync over the resolved scope, which mirrors `audit`'s exactly: `--root` is the root
 * block only, `--all` is every discovered package and never the root, and no flag is the single
 * package walked up from cwd. Nothing here throws on a per-file error — a failure comes back as
 * an entry with `action: 'failed'`, because a run that aborted halfway could leave exactly one
 * well-formed block behind, adopting the workspace and reddening every package it never reached.
 */
const syncScope = async (options: AuditFixOptions, repoRoot: string): Promise<GuidanceWrite[]> => {
  if (options.root) {
    return syncRootGuidance(repoRoot, { version: packageJson.version })
  }

  if (options.all) {
    const written: GuidanceWrite[] = []

    for (const packageDir of await discoverPackages(repoRoot)) {
      written.push(...(await syncOnePackage(packageDir, repoRoot, options.design)))
    }

    return written
  }

  const packageDir = await findPackageRoot(options.cwd ?? process.cwd())

  return syncOnePackage(packageDir, repoRoot, options.design)
}

/** `unchanged` files are counted, not listed — a 63-package refresh must not cost 63 lines. */
const buildSummaryLine = (written: GuidanceWrite[]): string => {
  const counts = new Map<WriteAction, number>()

  for (const file of written) {
    counts.set(file.action, (counts.get(file.action) ?? 0) + 1)
  }

  const parts = COUNT_ORDER.filter((action) => {
    return ALWAYS_COUNTED.includes(action) || (counts.get(action) ?? 0) > 0
  }).map((action) => {
    return `${counts.get(action) ?? 0} ${action}`
  })

  return `Agent guidance synced — ${parts.join(', ')} (infra-kit ${packageJson.version})`
}

/**
 * Print one line per changed file, then the summary. Paths are repo-relative because the
 * absolute ones are noise in a CI log, and a failed write names its reason inline: the exit
 * code says a write failed, only this line says which one and why.
 */
const logWrites = (written: GuidanceWrite[], repoRoot: string): void => {
  for (const file of written) {
    if (file.action === 'unchanged') continue

    const relPath = path.relative(repoRoot, file.path)
    const type = file.type ? ` (${file.type})` : ''
    const reason = file.action === 'failed' && file.message ? ` — ${file.message}` : ''

    logger.info(`  ${file.action.padEnd(9)} ${relPath}${type}${reason}`)
  }

  logger.info(buildSummaryLine(written))
}

/** Drop the failure `message`, which is logged rather than published in `structuredContent`. */
const toFixedEntry = (file: GuidanceWrite): FixedEntry => {
  const entry: FixedEntry = { path: file.path, action: file.action }

  if (file.type) entry.type = file.type

  return entry
}

/**
 * The `audit --fix` branch: write the guidance blocks for the resolved scope, log what changed,
 * and report whether the run flipped the workspace into adoption. Runs BEFORE the checks (the
 * `eslint --fix` model), so a block this call just created reports `ok` in the same invocation.
 *
 * Sets no exit code — `audit()`'s standing invariant is that it never touches `process.exitCode`,
 * so the MCP tool can reuse it. The `fixed` entries carrying `action: 'failed'` are the signal;
 * `program.ts` turns them into an exit code.
 *
 * The adoption cache is dropped on both sides of the sync: before, so the pre-fix verdict is the
 * real working-tree state rather than a memo from earlier in the process, and after, so the
 * post-fix verdict — the one `audit()` then threads into every check — sees the files just written.
 *
 * @example
 * await runAuditFix({ all: true }, '/repo')
 * // logs:  created   apps/demo/ui/CLAUDE.md (frontend)
 * //        Agent guidance synced — 3 unchanged, 1 created (infra-kit 0.4.0)
 * // => { fixed: [{ path: '/repo/apps/demo/ui/CLAUDE.md', action: 'created', type: 'frontend' }], adoptionFlipped: false }
 */
export const runAuditFix = async (options: AuditFixOptions, workspaceRoot: string | null): Promise<AuditFixResult> => {
  const repoRoot = await getProjectRoot()

  resetAdoptionCache()

  const before = await resolveAdoption(workspaceRoot)
  const written = await syncScope(options, repoRoot)

  logWrites(written, repoRoot)
  resetAdoptionCache()

  const after = await resolveAdoption(workspaceRoot)
  // An `--all` or `--root` run leaves no package behind, so it can never be the run that makes
  // every other package start failing. Only a scoped fix can.
  const singleScope = !options.all && !options.root

  return {
    fixed: written.map(toFixedEntry),
    adoptionFlipped: singleScope && !before.adopted && after.adopted,
  }
}
