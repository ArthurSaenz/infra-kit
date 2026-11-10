import { resolveAgentModeSource } from 'src/lib/agent-mode'
import type { ResolveAgentModeInput } from 'src/lib/agent-mode'
import { autoSetupLogPath } from 'src/lib/auto-setup/record'
import type { AutoSetupRecord } from 'src/lib/auto-setup/record'
import { listPendingResolutions } from 'src/lib/merge-dev-records'
import { tildify } from 'src/lib/path-display'

import { SETTINGS_FILES, inspectAgentAllowlist } from '../agent-allowlist'
import type { AllowlistCatalogEntry } from '../agent-allowlist'
import type { CheckResult } from '../check-result'

/**
 * The `background setup` row: what the last `setup --auto` pass did. Advisory in every state — a pass
 * that left work behind is `warn`, never `fail`, because the machine still works and `infra-kit setup`
 * is the fix; a pass that has not run for this version yet is `skip`, since it runs on its own.
 *
 * @example
 * checkAutoSetup(null, '0.19.0') // => { name: 'background setup', status: 'skip', message: 'not run yet — …' }
 */
export const checkAutoSetup = (record: AutoSetupRecord | null, version: string): CheckResult => {
  const name = 'background setup'

  if (record === null) {
    return { name, status: 'skip', message: 'not run yet — it runs after the next background update check' }
  }

  if (record.version !== version) {
    return {
      name,
      status: 'skip',
      message: `last ran for ${record.version}; runs for ${version} after the next background update check`,
    }
  }

  if (record.finishedMs === null) {
    return { name, status: 'skip', message: `a pass for ${version} is running, or was interrupted and will be retried` }
  }

  const left = record.runs.filter((run) => {
    return run.status !== 'ok'
  })

  if (left.length === 0) {
    return {
      name,
      status: 'pass',
      message: `ran for ${version} on the machine and ${record.runs.length - 1} project(s)`,
    }
  }

  return {
    name,
    status: 'warn',
    message: `${left.length} run(s) left work for you (${left
      .map((run) => {
        return `${run.root ?? 'machine'}: ${run.status}`
      })
      .join(', ')}) — see ${tildify(autoSetupLogPath())}, or run: infra-kit setup`,
  }
}

/** The raw inputs, spelled out so a pasted row explains its own verdict. */
const describeAgentModeInputs = ({ env, stdinIsTTY, flag }: ResolveAgentModeInput): string => {
  const agentVar = env.INFRA_KIT_AGENT === undefined ? 'unset' : `= "${env.INFRA_KIT_AGENT}"`

  return [
    `CLAUDECODE ${env.CLAUDECODE === undefined ? 'unset' : 'set'}`,
    `INFRA_KIT_AGENT ${agentVar}`,
    `stdin ${stdinIsTTY ? 'is a TTY' : 'is not a TTY'}`,
    `--agent ${flag ? 'passed' : 'not passed'}`,
  ].join(', ')
}

/**
 * The `Agent mode` row: which source `resolveAgentModeSource` fires on for THIS shell, with the inputs
 * it read. Informational — always a pass — because neither answer is wrong: a human at a PTY and an
 * agent under Claude Code are both correct classifications, and what the row is for is the third case,
 * where someone expected one and got the other (a `!` shell reads as agent; an Orca terminal Claude Code
 * spawned reads as human).
 *
 * Pure over its input so the precedence table (`agent-mode.ts`) is what the test drives, not the
 * test runner's own environment.
 *
 * @example
 * checkAgentMode({ env: { CLAUDECODE: '1' }, stdinIsTTY: false, flag: false })
 * // => { name: 'Agent mode', status: 'pass', message: 'agent — CLAUDECODE is set and stdin is not a TTY (…)' }
 */
export const checkAgentMode = (input: ResolveAgentModeInput): CheckResult => {
  const name = 'Agent mode'
  const source = resolveAgentModeSource(input)
  const inputs = describeAgentModeInputs(input)

  const because = (): string => {
    if (source === 'flag') return 'the --agent flag, which beats every environment value'
    if (input.env.INFRA_KIT_AGENT === '1') return 'INFRA_KIT_AGENT=1'
    if (source === 'env') return 'CLAUDECODE is set and stdin is not a TTY'
    if (input.env.CLAUDECODE !== undefined && input.stdinIsTTY) {
      return 'CLAUDECODE is set but stdin is a TTY, so this is a terminal Claude Code spawned for a person'
    }
    if (input.env.INFRA_KIT_AGENT === '0') return 'INFRA_KIT_AGENT=0 suppresses the CLAUDECODE heuristic'

    return 'no source fires; pass --agent or set INFRA_KIT_AGENT=1 to drive this CLI as an agent'
  }

  return {
    name,
    status: 'pass',
    message: `${source === null ? 'human' : 'agent'} — ${because()} (${inputs})`,
  }
}

/** At most this many command names per pattern before `+N more`: a `Bash(infra-kit:*)` reaches ~20. */
const NAMED_COMMANDS_PER_HIT = 4

const describeReachedCommands = (commands: string[]): string => {
  const named = commands.slice(0, NAMED_COMMANDS_PER_HIT).join(', ')
  const rest = commands.length - NAMED_COMMANDS_PER_HIT

  return rest > 0 ? `${named} +${rest} more` : named
}

/**
 * The `Agent allowlist` row (plan §3.8): WARN when a `permissions.allow` pattern in either project
 * settings file reaches a mutating infra-kit command, naming the pattern and what it reaches. A prefix
 * allow is what lets an agent's `--yes` re-run go unprompted, so the row is the one place that
 * exposure is visible. Never a fail: the setting is legal, and `doctor` does not know the human did not
 * choose it deliberately.
 *
 * @example
 * checkAgentAllowlist('/repo-allowing-Bash(infra-kit:*)', commandCatalog)
 * // => { name: 'Agent allowlist', status: 'warn', message: '.claude/settings.local.json allows "Bash(infra-kit:*)", which reaches …' }
 */
export const checkAgentAllowlist = (root: string, catalog: readonly AllowlistCatalogEntry[]): CheckResult => {
  const name = 'Agent allowlist'
  const { present, unreadable, hits } = inspectAgentAllowlist(root, catalog)

  if (hits.length > 0) {
    const findings = hits.map((hit) => {
      return `${hit.file} allows "${hit.pattern}", which reaches ${hit.commands.length} mutating infra-kit command${hit.commands.length === 1 ? '' : 's'} (${describeReachedCommands(hit.commands)})`
    })

    return {
      name,
      status: 'warn',
      message: `${findings.join('; ')} — a prefix allow lets an agent run the --yes re-run of a mutating command unprompted; narrow it to read-only argv (e.g. Bash(infra-kit release list:*)) so the host prompts for the rest`,
    }
  }

  if (unreadable.length > 0) {
    return {
      name,
      status: 'warn',
      message: `Could not read permissions.allow from ${unreadable.join(' and ')} — fix the JSON and re-run; until then the allowlist is unchecked`,
    }
  }

  if (present.length === 0) {
    return {
      name,
      status: 'pass',
      message: `no ${SETTINGS_FILES.join(' or ')} at the repo root — no Bash allow pattern to reach a mutating infra-kit command`,
    }
  }

  return {
    name,
    status: 'pass',
    message: `no permissions.allow pattern in ${present.join(' or ')} reaches a mutating infra-kit command`,
  }
}

export const agentAllowlistRow = (
  gitRoot: string | null,
  catalog: readonly AllowlistCatalogEntry[] | undefined,
): CheckResult => {
  if (gitRoot === null) return { name: 'Agent allowlist', status: 'skip', message: 'no git root' }

  if (catalog === undefined) return { name: 'Agent allowlist', status: 'skip', message: 'no command catalog supplied' }

  return checkAgentAllowlist(gitRoot, catalog)
}

const describeAge = (createdAt: string, now: number): string => {
  const hours = Math.floor((now - Date.parse(createdAt)) / 3_600_000)

  if (Number.isNaN(hours)) return 'age unknown'

  return hours >= 24 ? `${Math.floor(hours / 24)}d old` : `${Math.max(hours, 0)}h old`
}

/**
 * Flag `release merge-dev --keep-conflicts` hand-offs nobody finished. Nothing else ever surfaces
 * them: the resolution worktree is detached, so `worktrees list/sync/remove` never see it, and its
 * state file lives under the git common dir. A `warn`, never a `fail` — an unfinished hand-off may be
 * mid-resolution on purpose — and never `--fix`ed, because dropping one discards resolution work.
 *
 * @example
 * await checkMergeDevResolutions('/repo')
 * // => { name: 'merge-dev resolutions', status: 'warn', message: '1 unfinished merge-dev hand-off: release/v1.2.0 (3d old, ~/repo-worktrees/merge-dev/release-v1-2-0) — …' }
 */
export const checkMergeDevResolutions = async (root: string | null, now = Date.now()): Promise<CheckResult> => {
  const name = 'merge-dev resolutions'

  if (root === null) return { name, status: 'skip', message: 'no git root' }

  let pending: Awaited<ReturnType<typeof listPendingResolutions>>

  try {
    pending = await listPendingResolutions(root)
  } catch (err) {
    return { name, status: 'skip', message: `could not read the merge-dev state: ${(err as Error).message}` }
  }

  if (pending.length === 0) return { name, status: 'pass', message: 'no merge-dev hand-off in progress' }

  const rows = pending.map((entry) => {
    const where = entry.worktreeExists ? tildify(entry.worktreePath) : 'worktree missing'

    return `${entry.branch} (${describeAge(entry.createdAt, now)}, ${where})`
  })

  const versions = pending
    .map((entry) => {
      return entry.branch
    })
    .join(',')

  return {
    name,
    status: 'warn',
    message: `${pending.length} unfinished merge-dev hand-off${pending.length === 1 ? '' : 's'}: ${rows.join('; ')} — finish with: infra-kit release merge-dev --continue --versions ${versions}, or drop with --abort`,
  }
}
