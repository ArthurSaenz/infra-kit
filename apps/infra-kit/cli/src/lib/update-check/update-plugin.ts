/**
 * The Claude Code plugin half of the update worker: `claude plugin update infra-kit@infra-kit` for
 * every project this machine has the plugin installed in.
 *
 * WHY THE WORKER AND NOT CLAUDE CODE: Claude Code never advances an installed plugin on its own and
 * prints nothing for installed-but-old, so a plugin bump on `main` reached nobody until they typed
 * `claude plugin update` by hand — the CLI kept itself fresh while the skills it ships with rotted.
 * This step rides the same throttled child, so a plugin-only bump is delivered on the next check.
 *
 * Everything here is imported statically (see `run-update-check.ts`): on the `installed` path this runs
 * AFTER `npm install -g` has replaced `dist/`, where a lazy `import()` of a chunk is unsafe.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

import {
  CLAUDE_BIN,
  CLAUDE_VERSION_ARGV,
  PLUGIN_UPDATE_ARGV,
  defaultClaudeRunner,
} from 'src/lib/plugin-pointer/claude-cli'
import type { ClaudeRunner } from 'src/lib/plugin-pointer/claude-cli'
import { listProjectPluginInstallations } from 'src/lib/plugin-pointer/install-state'
import type { PluginInstallation } from 'src/lib/plugin-pointer/install-state'
import { withoutPackageManagerEnv } from 'src/lib/pm-env'

import type { PluginUpdateOutcome } from './update-cache'

/**
 * Probe plus every per-project run, end to end. Well inside `LOCK_STALE_MS` (30 min) even after a slow
 * CLI install has already spent minutes of the same lock — a plugin step that outlived the lock would
 * hand the next shell's worker a reaped lock and the concurrent-install pile-up the lock exists to stop.
 */
export const PLUGIN_UPDATE_BUDGET_MS = 5 * 60 * 1000

/** One `claude plugin update` measured at ≈0.7 s; a minute is a wedged network, not a slow one. */
export const PLUGIN_UPDATE_RUN_TIMEOUT_MS = 60_000

export interface UpdatePluginDeps {
  env?: NodeJS.ProcessEnv
  /** Deadline source, injected so the budget is testable without real time. */
  clock?: () => number
  /** The `claude --version` probe. Output is captured and discarded; only `ok` is read. */
  runClaude?: ClaudeRunner
  /** The per-project update spawn — its own seam, so the CLI-install spawn's call count stays honest. */
  spawnPluginUpdate?: typeof spawnSync
  /** The project-scope install records; defaults to reading `~/.claude/plugins/installed_plugins.json`. */
  listPluginInstallations?: () => readonly PluginInstallation[]
  pathExists?: (target: string) => boolean
}

type RecordResult = 'ok' | 'skipped' | 'failed'

interface UpdateContext {
  spawn: typeof spawnSync
  env: NodeJS.ProcessEnv
  clock: () => number
  deadlineMs: number
  pathExists: (target: string) => boolean
}

/**
 * The child env: npx/dlx markers stripped like every other child this CLI spawns, plus `CLAUDECODE`
 * — the marker a nested Claude Code refuses to start under. Whether `plugin update` shares that
 * refusal was not measured; the spike that proved this command ran without it, so it stays out.
 */
const pluginUpdateEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const child = withoutPackageManagerEnv(env)

  delete child.CLAUDECODE

  return child
}

const isEnoent = (error: Error): boolean => {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * One recorded project. `cwd` is the whole mechanism: `claude` resolves WHICH project-scope record an
 * update touches from the cwd, and from a non-project directory it silently picks some other record.
 *
 * A path that no longer exists is skipped, never a failure — `installed_plugins.json` is append-only,
 * so records for deleted checkouts outlive the checkouts. `ENOENT` from the spawn is the same case
 * caught a moment later (the directory vanished between the check and the spawn).
 */
const updateRecordedProject = (record: PluginInstallation, ctx: UpdateContext): RecordResult => {
  const projectPath = record.projectPath

  if (projectPath === null || !ctx.pathExists(projectPath)) return 'skipped'

  const remainingMs = ctx.deadlineMs - ctx.clock()

  if (remainingMs <= 0) return 'failed'

  const result = ctx.spawn(CLAUDE_BIN, [...PLUGIN_UPDATE_ARGV], {
    cwd: projectPath,
    // Silent, like the CLI install: this is a detached worker with nowhere to write.
    stdio: 'ignore',
    shell: process.platform === 'win32',
    env: ctx.env,
    timeout: Math.min(PLUGIN_UPDATE_RUN_TIMEOUT_MS, remainingMs),
    windowsHide: true,
  })

  if (result.error) return isEnoent(result.error) ? 'skipped' : 'failed'

  return result.signal === null && result.status === 0 ? 'ok' : 'failed'
}

const updatePluginUnguarded = (deps: UpdatePluginDeps): PluginUpdateOutcome => {
  const clock = deps.clock ?? Date.now
  // The probe's own timeout (`CLAUDE_TIMEOUT_MS`) is inside this budget, not in addition to it.
  const deadlineMs = clock() + PLUGIN_UPDATE_BUDGET_MS
  const runClaude = deps.runClaude ?? defaultClaudeRunner

  // The only gate besides the lock. `canSelfSpawn` is a question about where npm put the CLI and says
  // nothing about `claude`; a Homebrew-owned CLI still gets its plugin updated.
  if (!runClaude({ args: CLAUDE_VERSION_ARGV }).ok) return 'claude-missing'

  const records = (deps.listPluginInstallations ?? listProjectPluginInstallations)()

  if (records.length === 0) return 'skipped'

  const ctx: UpdateContext = {
    spawn: deps.spawnPluginUpdate ?? spawnSync,
    env: pluginUpdateEnv(deps.env ?? process.env),
    clock,
    deadlineMs,
    pathExists: deps.pathExists ?? fs.existsSync,
  }

  // Every record gets its turn even after one fails: the records are independent projects, and a
  // failure in one is no reason to leave another stale. The verdict is still `failed` — the manual
  // command is what fixes the one that did not take.
  const results = records.map((record) => {
    return updateRecordedProject(record, ctx)
  })

  if (results.includes('failed')) return 'failed'

  return results.includes('ok') ? 'updated' : 'skipped'
}

/**
 * Update the installed plugin in every recorded project. NEVER throws: a plugin failure is a recorded
 * outcome, not a reason to lose the CLI outcome the worker has already produced.
 *
 * @example
 * updatePlugin({ listPluginInstallations: () => [] }) // => 'skipped'
 */
export const updatePlugin = (deps: UpdatePluginDeps = {}): PluginUpdateOutcome => {
  try {
    return updatePluginUnguarded(deps)
  } catch {
    return 'failed'
  }
}
