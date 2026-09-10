import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { syncPackageGuidance, syncRootGuidance } from 'src/lib/agent-guidance'
import type { GuidanceWrite, WriteAction } from 'src/lib/agent-guidance'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { discoverPackages, readDeclaredPackageType } from 'src/lib/package-validator/loader'

import packageJson from '../../../package.json' with { type: 'json' }

// Re-exported on their historical import path so `doctor` and the existing tests keep
// resolving after the markers and write rails moved into `src/lib/agent-guidance`.
export {
  LEGACY_IMPORT_END as AGENTS_IMPORT_END,
  LEGACY_IMPORT_START as AGENTS_IMPORT_START,
} from 'src/lib/agent-guidance'
export { ROOT_MARKER_END as AGENTS_MARKER_END, ROOT_MARKER_START as AGENTS_MARKER_START } from 'src/lib/agent-guidance'
export type { WriteAction } from 'src/lib/agent-guidance'

const CLAUDE_FILE = 'CLAUDE.md'

export interface AgentFileWrite {
  path: string
  action: WriteAction
}

export interface WriteAgentFilesResult {
  /** True when run outside an infra-kit repo (no `infra-kit.json` at the git root). */
  skipped: boolean
  /** Repo root the files were written under, or null when skipped. */
  root: string | null
  written: AgentFileWrite[]
}

const INFRA_KIT_CONFIG_FILE = 'infra-kit.json'

/**
 * The one skip announcement for every step gated on {@link resolveGitRootForWrites}.
 *
 * It names all four steps because one `null` skips all four: naming only the guidance
 * files (as it did while a single gate served everything) leaves a reader who lost the
 * plugin pointer, the plugin install and the `.mcp.json` write with no record of it.
 */
const SKIPPED_GIT_ROOT_STEPS =
  'Skipped agent-instruction files, the plugin pointer, the plugin install and .mcp.json — no usable git repo root here (not a git repo, or the root is your home directory)'

/**
 * The skip announcement for the guidance-only gate.
 *
 * Names the other three steps as UNAFFECTED: after the gate split this `null` stops the
 * guidance files alone, so a reader who saw the old text would wrongly assume the pointer,
 * the install and the `.mcp.json` write were skipped too.
 */
const SKIPPED_GUIDANCE_ONLY =
  'Skipped agent-instruction files — no infra-kit.json at the repo root (the plugin pointer, the plugin install and .mcp.json are unaffected)'

/**
 * The git toplevel, or `null` when there is no root safe to write into — a failed resolve,
 * a blank resolve, or `$HOME`.
 *
 * SILENT, and that is load-bearing: this answers a question, it does not narrate a decision.
 * `doctor` consults it read-only to decide whether the `MCP server key` row is answerable, and
 * a predicate that logs made a read-only command print `initCore`'s "Skipped …" line — first, above
 * its own report header — in every non-git directory and in `$HOME`. Writers announce through
 * {@link resolveGitRootForWrites}; a new reader gets silence by default, which is the safe
 * direction for a default to fail in.
 *
 * Worktree-local by design: Claude Code reads `.mcp.json` and `.claude/settings.json` from
 * the session cwd, and sessions do run in worktrees, so `getMainRepoRoot` would write config
 * a worktree session never reads.
 *
 * @example
 * const root = await resolveGitRoot()
 * // => '/Users/me/projects/api'   (or null, and nothing is logged)
 */
export const resolveGitRoot = async (): Promise<string | null> => {
  let resolved: string

  try {
    resolved = await getProjectRoot()
  } catch {
    return null
  }

  const root = resolved.trim()

  // Blank is a failed resolve by contract, not a lenient case. `getProjectRoot` is
  // `result.stdout.trim()` and rejects only when the shell-out itself fails, so empty
  // stdout resolves as `''` — and `''` is not merely an invalid root but a cwd-relative
  // one: every `path.join('', x)` silently targets `process.cwd()`, and `'' !== homedir()`
  // means the home check below would pass it.
  //
  // `$HOME` is checked here because "inside a git repo" does not protect the home
  // directory: anyone who git-manages their dotfiles has a repo there, and this is all
  // that stands between that and a `.claude/` directory written into it.
  if (root === '' || root === os.homedir()) return null

  return root
}

/**
 * {@link resolveGitRoot} for the callers that were about to WRITE — the same predicate, plus the
 * announcement.
 *
 * The line lives here because `initCore` is the only caller for whom the skip is otherwise invisible:
 * the steps it gates (the plugin pointer, the plugin install, the `.mcp.json` write) are silent
 * when they do not run, so this is the only evidence they did not. A decorator rather than a
 * `quiet` parameter: a boolean would default to loud, and the next reader who needs the predicate
 * would forget to pass it.
 *
 * @example
 * const root = await resolveGitRootForWrites()
 * // => '/Users/me/projects/api'   (or null, with the four-step skip logged)
 */
export const resolveGitRootForWrites = async (): Promise<string | null> => {
  const root = await resolveGitRoot()

  if (root === null) logger.info(SKIPPED_GIT_ROOT_STEPS)

  return root
}

/**
 * The git toplevel of an infra-kit repo — {@link resolveGitRoot} plus an `infra-kit.json`
 * at that root — or `null`.
 *
 * Gates the guidance writers only. They render config-derived content, so the config file
 * is a real precondition for them; the plugin and MCP steps never read it.
 *
 * Announces its OWN predicate only. A refused git gate returns `null` silently here, because
 * `initCore` calls {@link resolveGitRootForWrites} for the same refusal — one gate, one line, rather
 * than the duplicate a delegating announcement produced.
 *
 * @example
 * const root = await resolveInfraKitRoot()
 * // => '/Users/me/projects/api'   (null in a git repo with no infra-kit.json)
 */
export const resolveInfraKitRoot = async (): Promise<string | null> => {
  const root = await resolveGitRoot()

  if (root === null) return null

  if (!fs.existsSync(path.join(root, INFRA_KIT_CONFIG_FILE))) {
    logger.info(SKIPPED_GUIDANCE_ONLY)

    return null
  }

  return root
}

/**
 * Re-throw a root write failure.
 *
 * `syncRootGuidance` is continue-and-report — it never throws — because a multi-package fix
 * run must not abort halfway. `writeAgentFiles` is the opposite case: one file, written by a
 * command a human ran deliberately, whose failure has always propagated (a symlinked
 * `CLAUDE.md` still aborts `initCore`). Restoring that here keeps the CLI behaviour unchanged
 * while the library stays reusable by the multi-file writer.
 */
const rethrowFailures = (written: GuidanceWrite[]): void => {
  const failure = written.find((entry) => {
    return entry.action === 'failed'
  })

  if (failure) throw new Error(failure.message ?? `Failed to write ${failure.path}`)
}

/**
 * Generate (or refresh) the repo agent-instruction guidance, now hosted solely in
 * `CLAUDE.md` (preserving hand-authored content outside the markers). Also migrates
 * legacy setups — stripping the old `@AGENTS.md` import region from `CLAUDE.md` and
 * backing up/removing a now-redundant `AGENTS.md`. Repo-gated: a no-op outside an
 * infra-kit repo. Idempotent (within a CLI version) and non-destructive.
 *
 * A thin wrapper over {@link syncRootGuidance}: the repo gate, the logging and the result
 * shape live here, the write rails live in `src/lib/agent-guidance`.
 *
 * @example
 * await writeAgentFiles()
 * // INFO: Agent-instruction files synced (infra-kit 0.1.105)
 */
export const writeAgentFiles = async (): Promise<WriteAgentFilesResult> => {
  const root = await resolveInfraKitRoot()

  if (root === null) return { skipped: true, root: null, written: [] }

  const version = packageJson.version
  const written = await syncRootGuidance(root, { version })

  rethrowFailures(written)

  const claudePath = path.join(root, CLAUDE_FILE)

  for (const file of written) {
    // Always report CLAUDE.md; only mention a migrated file when it actually changed.
    if (file.action === 'unchanged' && file.path !== claudePath) continue

    logger.info(`  ${file.action.padEnd(9)} ${path.relative(root, file.path)}`)
  }

  logger.info(`Agent-instruction files synced (infra-kit ${version})`)

  return {
    skipped: false,
    root,
    written: written.map((file) => {
      return { path: file.path, action: file.action }
    }),
  }
}

export interface SyncRepoGuidanceResult {
  /** True when run outside an infra-kit repo (no `infra-kit.json` at the git root). */
  skipped: boolean
  /** Repo root every path was written under, or `null` when skipped. */
  root: string | null
  /** CLI version recorded in every block this run wrote. */
  version: string
  /**
   * Every write this run attempted — the two root files first, then one entry per
   * discovered package. Entries with `action: 'failed'` carry a `message`; the caller
   * decides how loud that is.
   */
  written: GuidanceWrite[]
}

/**
 * Discover the workspace packages under `root`, degrading to "no packages" when the
 * workspace cannot be read.
 *
 * `discoverPackages` reads `pnpm-workspace.yaml` and rejects with `ENOENT` when there
 * is none. A single-package infra-kit repo is a legitimate setup, so that rejection
 * must not abort `initCore` — it means "the root block is the whole job".
 */
const discoverWorkspacePackages = async (root: string): Promise<string[]> => {
  try {
    return await discoverPackages(root)
  } catch (err) {
    logger.debug({ err, msg: 'Skipped per-package agent guidance — no workspace packages could be discovered.' })

    return []
  }
}

/**
 * Refresh the agent-instruction guidance across the WHOLE repo: the root `CLAUDE.md`
 * (plus the legacy `AGENTS.md` migration) and one managed block per workspace package.
 * Repo-gated exactly like {@link writeAgentFiles} — a no-op outside an infra-kit repo.
 *
 * Continue-and-report throughout: nothing here throws, and a per-file error comes back as
 * an entry with `action: 'failed'`. A run that aborted halfway could leave exactly one
 * well-formed package block behind, which adopts the workspace and reddens every package
 * the run never reached.
 *
 * Writes unconditionally — it does not ask, and does not skip an unadopted workspace.
 * `initCore` is the repo-wide refresh path, so a consumer re-running it after a CLI upgrade
 * gets every block regenerated in one pass.
 *
 * @example
 * const result = await syncRepoGuidance()
 * // => { skipped: false, root: '/repo', version: '0.4.0', written: [ ...root, ...packages ] }
 */
export const syncRepoGuidance = async (): Promise<SyncRepoGuidanceResult> => {
  const root = await resolveInfraKitRoot()
  const version = packageJson.version

  if (root === null) return { skipped: true, root: null, version, written: [] }

  const written: GuidanceWrite[] = [...(await syncRootGuidance(root, { version }))]

  for (const packageDir of await discoverWorkspacePackages(root)) {
    // Total by contract: an absent, unloadable or unrecognised config resolves to `undefined`
    // rather than rejecting, so one broken package config cannot abort the repo-wide sync.
    const declaredType = await readDeclaredPackageType(packageDir)

    written.push(...(await syncPackageGuidance(packageDir, { repoRoot: root, version, declaredType })))
  }

  return { skipped: false, root, version, written }
}
