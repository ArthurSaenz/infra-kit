/**
 * @fileoverview
 * Agent-mode flag for the CLI: "no human is at the other end of stdin". Anything that would read
 * keystrokes (raw `data` listeners, Ink screens, `@inquirer` prompts) must be gated off, and any
 * guard that exists because an agent needs a human's say-so keys on it.
 *
 * Two sources, and they are not interchangeable — the source is kept, not just the boolean, so a
 * refusal can word itself for the caller it actually has:
 * - `'flag'`: the global `--agent` option. Beats every environment value, `INFRA_KIT_AGENT=0`
 *   included — a skill that passes `--agent` must never be silently demoted by a variable in
 *   someone's `.zshenv`.
 * - `'env'`: `INFRA_KIT_AGENT=1`, or `CLAUDECODE` set with a non-TTY stdin. The TTY qualifier is the
 *   point: `CLAUDECODE=1` is inherited by every process Claude Code spawns, including the Orca
 *   terminals `worktrees add` opens, and those are humans at a PTY. `INFRA_KIT_AGENT=0` suppresses
 *   only that heuristic; any other value is ignored as if unset.
 *
 * `process.stdin.isTTY` alone is not the agent signal: a non-TTY stdin is also every zsh `$(…)`
 * capture and CI job, and `--agent` from a terminal has a TTY — hence the declared flag plus the
 * `CLAUDECODE` ∧ non-TTY conjunction.
 */
import process from 'node:process'

import { jsonOutput } from 'src/lib/json-output'

export type AgentModeSource = 'flag' | 'env' | null

/** Mutable holder (object so `prefer-const` holds while the source toggles per run). */
export const agentMode = { source: null as AgentModeSource }

/** True when an agent, not a human, is driving this process — whichever source said so. */
export const isAgentMode = (): boolean => {
  return agentMode.source !== null
}

/**
 * True when nobody can answer a prompt: an agent is driving, or `--json` has claimed stdout for a
 * machine. Every confirm and picker site keys on this one predicate so the 20-odd sites agree; the
 * few that also care WHICH source read `agentMode.source` next to it.
 */
export const isHeadless = (): boolean => {
  return isAgentMode() || jsonOutput.enabled
}

/**
 * True on a CI runner (every major one exports `CI`). The config loader withholds its layer-1
 * rewrite there, because a tracked file changed on an ephemeral checkout is lost with the job —
 * the fix has to be committed on the branch instead. Not an agent signal: CI has no human either,
 * but `isAgentMode` keys on who is DRIVING, not where it runs.
 */
export const isCI = (): boolean => {
  return Boolean(process.env.CI)
}

export interface ResolveAgentModeInput {
  env: NodeJS.ProcessEnv
  stdinIsTTY: boolean
  /** The global `--agent` option as Commander parsed it. */
  flag: boolean
}

/**
 * Pure precedence over the two sources. Called once per run from `program.hook('preAction')`.
 *
 * @example
 * resolveAgentModeSource({ env: { INFRA_KIT_AGENT: '0' }, stdinIsTTY: true, flag: true }) // 'flag'
 * resolveAgentModeSource({ env: { INFRA_KIT_AGENT: '1' }, stdinIsTTY: true, flag: false }) // 'env'
 * resolveAgentModeSource({ env: { CLAUDECODE: '1' }, stdinIsTTY: false, flag: false }) // 'env'
 * resolveAgentModeSource({ env: { CLAUDECODE: '1', INFRA_KIT_AGENT: '0' }, stdinIsTTY: false, flag: false }) // null
 * resolveAgentModeSource({ env: { CLAUDECODE: '1' }, stdinIsTTY: true, flag: false }) // null
 */
export const resolveAgentModeSource = ({ env, stdinIsTTY, flag }: ResolveAgentModeInput): AgentModeSource => {
  if (flag) return 'flag'

  const agentVar = env.INFRA_KIT_AGENT

  if (agentVar === '1') return 'env'

  const claudeCodeHeuristic = env.CLAUDECODE !== undefined && !stdinIsTTY && agentVar !== '0'

  return claudeCodeHeuristic ? 'env' : null
}
