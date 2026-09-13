/**
 * One command that sets a machine up: the local, offline `initCore` half first, then the dependency
 * converge, then one combined summary.
 *
 * The order is not arbitrary. The init half is local, cheap, and one of its steps (`.mcp.json` plus the
 * plugin install) is what makes the MCP surface usable at all, so it must not sit behind a network
 * converge. The refused recipes' manual commands are the last thing the human reads, and the
 * `source ~/.zshrc` reminder is last of all.
 *
 * Both halves ALWAYS run: neither short-circuits the other, an init-half throw is recorded and the
 * dependency half still runs, and the run exits non-zero if either half hard-failed. A `risk-predicate`
 * refusal is not a failure — its argv is printed for a human, and the run still succeeds.
 */
import process from 'node:process'
import { z } from 'zod'

import { InitStepError, SHELL_ACTIVATION_REMINDER, initCore, logInitEntry } from 'src/commands/init'
import type { InitEntry, InitStep, InitStepName } from 'src/commands/init'
import type { runRecipe } from 'src/lib/dependency-install'
import type { ProbeDeps } from 'src/lib/dependency-probe'
import { DEPENDENCY_IDS } from 'src/lib/dependency-registry'
import type { DependencyId } from 'src/lib/dependency-registry'
import { logger } from 'src/lib/logger'
import { defineMcpTool, textContent } from 'src/types'

import { convergeDependencies, probeDependencies } from './converge'
import type { SetupMode, ToolResult } from './converge'

export interface SetupOptions {
  /** `--tools <ids...>`: converge only these. */
  tools?: DependencyId[]
  /** `--update [ids...]`: update what is present and never install; `true` means every tool. */
  update?: boolean | DependencyId[]
  /** `--skip-tools`: the read-only probe. Reports what is missing and the argv that would fix it. */
  skipTools?: boolean
  /** Probe seams for tests; production omits it. */
  probeDeps?: ProbeDeps
  /** The executor, injected so a test can assert what WOULD have run. Never reached under `skipTools`. */
  run?: typeof runRecipe
}

/**
 * A usage error rather than a precedence rule, deliberately.
 *
 * Every precedence answer is wrong here: silently ignoring `--skip-tools` installs software the caller
 * asked not to install, and silently ignoring `--tools` runs against a set they did not choose. There is
 * no reading of the combination that does what someone typing it meant.
 */
export const SKIP_TOOLS_CONFLICT =
  '--skip-tools cannot be combined with --tools or --update: --skip-tools installs and updates nothing at all, so narrowing what it would act on is a contradiction. Use one or the other.'

interface ResolvedRequest {
  ids: readonly DependencyId[]
  mode: SetupMode
  skipTools: boolean
}

const resolveRequest = (options: SetupOptions): ResolvedRequest => {
  const updateIds = Array.isArray(options.update) ? options.update : undefined
  const updating = options.update === true || updateIds !== undefined
  const skipTools = options.skipTools === true

  if (skipTools && (options.tools !== undefined || updating)) throw new Error(SKIP_TOOLS_CONFLICT)

  return {
    ids: options.tools ?? updateIds ?? DEPENDENCY_IDS,
    mode: updating ? 'update' : 'converge',
    skipTools,
  }
}

/**
 * Which step an untagged throw belongs to.
 *
 * `initCore` tags every step it runs, so the fallback covers only a throw from outside one — the last
 * step that reported is the furthest the run is known to have got, and an empty report means it died in
 * the first step.
 */
const failedStep = (err: unknown, completed: InitEntry[]): InitStepName => {
  if (err instanceof InitStepError) return err.step

  return completed.at(-1)?.step ?? 'zshrc'
}

/** Run the init half, printing as it goes, and report a throw as an entry instead of propagating it. */
const runInitHalf = async (): Promise<{ entries: InitEntry[]; failed: boolean }> => {
  const entries: InitEntry[] = []
  const sink = (entry: InitEntry): void => {
    entries.push(entry)

    // Everything prints where it happens — except the activation reminder, which `setup` holds back so
    // it lands after the dependency summary rather than in the middle of the run.
    if (entry.message !== SHELL_ACTIVATION_REMINDER) logInitEntry(entry)
  }

  try {
    await initCore(sink)

    return { entries, failed: false }
  } catch (err) {
    const entry: InitEntry = {
      step: failedStep(err, entries),
      outcome: 'warned',
      message: `The ${failedStep(err, entries)} step failed: ${err instanceof Error ? err.message : String(err)}`,
      level: 'warn',
    }

    logInitEntry(entry)
    entries.push(entry)

    return { entries, failed: true }
  }
}

/** One line per tool, then the argv a human has to run themselves, then the activation reminder. */
const printSummary = (tools: ToolResult[], skipTools: boolean): void => {
  for (const tool of tools) {
    logger.info(`  ${tool.action.padEnd(9)} ${tool.id} — ${tool.detail}`)
  }

  for (const tool of tools) {
    if (!needsManualRun(tool, skipTools)) continue

    logger.info(`Run these yourself to ${skipTools ? 'set up' : 'finish'} ${tool.id}:`)

    for (const command of tool.commands) {
      logger.info(`  ${command}`)
    }
  }

  logger.info(SHELL_ACTIVATION_REMINDER)
}

/** A tool whose argv the human has to run: every refusal, and — under the probe — everything not run. */
const needsManualRun = (tool: ToolResult, skipTools: boolean): boolean => {
  if (tool.commands.length === 0) return false

  return tool.action === 'refused' || (skipTools && tool.action === 'skipped')
}

/** The MCP payload carries the three declared keys and not the CLI's rendering hint. */
const toInitStep = (entry: InitEntry): InitStep => {
  return { step: entry.step, outcome: entry.outcome, message: entry.message }
}

export const setup = async (options: SetupOptions = {}) => {
  const request = resolveRequest(options)
  const init = await runInitHalf()
  const tools = request.skipTools
    ? await probeDependencies(request.ids, options.probeDeps)
    : await convergeDependencies({
        ids: request.ids,
        mode: request.mode,
        probeDeps: options.probeDeps,
        run: options.run,
      })

  printSummary(tools, request.skipTools)

  const structuredContent = {
    init: init.entries.map(toInitStep),
    tools,
    converged: !request.skipTools,
    changed: tools.some((tool) => {
      return tool.action === 'installed' || tool.action === 'updated'
    }),
    allSucceeded: tools.every((tool) => {
      return tool.action !== 'failed'
    }),
  }

  // The action owns the exit code, as `vendor-config` and `local-deploy` do: nothing downstream of here
  // reads the payload's booleans, so a hard failure in EITHER half has to be turned into one here or the
  // command exits 0 having failed.
  if (init.failed || !structuredContent.allSucceeded) process.exitCode = 1

  return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
}

const initStepSchema = z.object({
  step: z
    .enum([
      'zshrc',
      'migrations',
      'user-config',
      'guidance',
      'plugin-pointer',
      'mcp-server',
      'mcp-proxies',
      'project-config',
      'shell',
    ])
    .describe('Which init step this reports on'),
  outcome: z
    .enum(['written', 'unchanged', 'skipped', 'warned'])
    .describe('What that step did: changed something, found nothing to change, did not run, or failed non-fatally'),
  message: z.string().describe('The same line a human running this would have read'),
})

const resultSchema = z.object({
  id: z.string().describe('Dependency id'),
  action: z.enum(['installed', 'updated', 'skipped', 'refused', 'failed']).describe('What happened'),
  before: z
    .object({
      present: z.boolean(),
      onPath: z.boolean(),
      version: z.string().nullable(),
      manager: z.string(),
    })
    .describe('The tool’s state before this run'),
  commands: z.array(z.string()).describe('The exact commands, one per step — printed even when refused'),
  detail: z.string().describe('Why, in one line'),
})

const outputSchema = {
  init: z.array(initStepSchema).describe('One entry per init step, in the order they ran'),
  tools: z.array(resultSchema).describe('One result per requested dependency'),
  converged: z.boolean().describe('Whether the dependency step could act at all (false under skipTools)'),
  changed: z.boolean().describe('Whether anything was installed or updated'),
  allSucceeded: z.boolean().describe('Whether no tool failed (a refusal is not a failure)'),
}

const inputSchema = {
  tools: z
    .array(z.enum(DEPENDENCY_IDS as [DependencyId, ...DependencyId[]]))
    .optional()
    .describe('Which tools to act on. Omit for all five.'),
  mode: z
    .enum(['converge', 'update'])
    .optional()
    .describe('converge (default): install what is missing and update the rest. update: never install.'),
  skipTools: z
    .boolean()
    .optional()
    .describe('Read-only: run the init half, then REPORT what each tool needs without installing anything.'),
}

/**
 * Two gates fire in series on an MCP call, and that is intended rather than redundant.
 *
 * `_meta["anthropic/requiresUserInteraction"]` makes the HOST prompt a human on every call — in
 * `acceptEdits`, `auto` and `bypassPermissions` alike, with allow rules unable to skip it. The confirm
 * gate in `lib/tool-handler` then makes the AGENT re-call with a token bound to these arguments, which
 * raises the host prompt a second time. One successful install therefore costs the human two prompts.
 *
 * Neither substitutes for the other: `requiresHumanConfirm` is required for every exposed mutating tool
 * (`command-catalog.test.ts`) and is the only gate left on a host that ignores the annotation — anything
 * below Claude Code v2.1.199, and anything that is not Claude Code. Neither substitutes for the computed
 * refusal in `lib/dependency-install/risk-predicate`, which is the only control shipping inside the CLI.
 */
// Both fire UNCONDITIONALLY, `skipTools` included. The read path that raises no prompt is `doctor` — a
// separate tool name, therefore a separate permission identity, which is why the two are not one tool.
const REQUIRES_USER_INTERACTION = { 'anthropic/requiresUserInteraction': true } as const

export const setupMcpTool = defineMcpTool({
  name: 'setup',
  description:
    'Set this machine up in one call: inject the shell integration into .zshrc, run the config migrations, seed the user-global config, refresh the agent-instruction files, register the Claude Code plugin pointer and the infra-kit MCP server, then bring brew, aws, gh, doppler and portless to a working state — installing what is missing and updating what is present. Pass mode:"update" to update only and never install, or skipTools:true to do the local setup and then REPORT what each tool needs without installing anything. Recipes that need sudo or pipe a script fetched over the network — the Homebrew bootstrap and the first AWS CLI install — are never run; they are reported with the exact commands for you to run yourself. Use `doctor` first to see the state of this machine without changing it.',
  inputSchema,
  outputSchema,
  requiresHumanConfirm: true,
  meta: REQUIRES_USER_INTERACTION,
  handler: (params: { tools?: DependencyId[]; mode?: SetupMode; skipTools?: boolean }) => {
    return setup({ tools: params.tools, update: params.mode === 'update', skipTools: params.skipTools })
  },
})
