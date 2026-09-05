import fs from 'node:fs'
import path from 'node:path'

import { syncPackageGuidance, syncRootGuidance } from 'src/lib/agent-guidance'
import type { GuidanceWrite, WriteAction } from 'src/lib/agent-guidance'
import { getInfraKitConfigPaths } from 'src/lib/infra-kit-config'
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

/** The repo root, or `null` when this is not an infra-kit repo (the caller logs and skips). */
const resolveRepoRoot = async (): Promise<string | null> => {
  let mainConfigPath: string

  try {
    mainConfigPath = (await getInfraKitConfigPaths()).main
  } catch {
    logger.info('Skipped agent-instruction files — not inside an infra-kit repo')

    return null
  }

  if (!fs.existsSync(mainConfigPath)) {
    logger.info('Skipped agent-instruction files — no infra-kit.json at the repo root')

    return null
  }

  return path.dirname(mainConfigPath)
}

/**
 * Re-throw a root write failure.
 *
 * `syncRootGuidance` is continue-and-report — it never throws — because a multi-package fix
 * run must not abort halfway. `writeAgentFiles` is the opposite case: one file, written by a
 * command a human ran deliberately, whose failure has always propagated (a symlinked
 * `CLAUDE.md` still aborts `init`). Restoring that here keeps the CLI behaviour unchanged
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
  const root = await resolveRepoRoot()

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
 * must not abort `init` — it means "the root block is the whole job".
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
 * `init` is the repo-wide refresh path, so a consumer re-running it after a CLI upgrade
 * gets every block regenerated in one pass.
 *
 * @example
 * const result = await syncRepoGuidance()
 * // => { skipped: false, root: '/repo', version: '0.4.0', written: [ ...root, ...packages ] }
 */
export const syncRepoGuidance = async (): Promise<SyncRepoGuidanceResult> => {
  const root = await resolveRepoRoot()
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
