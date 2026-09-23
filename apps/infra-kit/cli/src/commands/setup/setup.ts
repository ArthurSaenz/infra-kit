/**
 * One command that sets a machine up: the local, offline `initCore` half first, then the dependency
 * converge, then the portless-service step, then one report table on stderr.
 *
 * The order is not arbitrary. The init half is local, cheap, and one of its steps (the plugin install,
 * which brings the `/infra-kit:*` skills) is what makes the agent surface usable at all, so it must not
 * sit behind a network converge. The table follows every streamed line, so the commands a human has to
 * run sit under their rows at the end, and the `source ~/.zshrc` reminder is last of all.
 *
 * Every step ALWAYS runs: an init-half or dependency-half throw is recorded as a `fail` row and the rest
 * still runs, and the run exits non-zero iff a row failed. A `risk-predicate` refusal is not a failure:
 * it is a `manual` row whose notes carry the argv for a human, and the run still succeeds.
 */
import process from 'node:process'
import { z } from 'zod'

import { portlessServiceTargetState } from 'src/commands/doctor/doctor'
import type { ServiceTargetDeps, ServiceTargetState } from 'src/commands/doctor/doctor'
import { InitStepError, SHELL_ACTIVATION_REMINDER, initCore } from 'src/commands/init'
import type { InitEntry, InitStep, InitStepName } from 'src/commands/init'
import {
  ensurePortlessLink,
  portlessLinkCliPath,
  realPortlessStableDeps,
  serviceInstallCommand,
} from 'src/dev/proxy/portless-link'
import type { EnsurePortlessLinkDeps, PortlessLinkOutcome } from 'src/dev/proxy/portless-link'
import { ensurePortlessNode } from 'src/dev/proxy/portless-node'
import type { EnsurePortlessNodeDeps, PortlessNodeResult } from 'src/dev/proxy/portless-node'
import type { runRecipe } from 'src/lib/dependency-install'
import type { ProbeDeps } from 'src/lib/dependency-probe'
import { DEPENDENCY_IDS } from 'src/lib/dependency-registry'
import type { DependencyId } from 'src/lib/dependency-registry'
import { logger } from 'src/lib/logger'
import { printRunReport } from 'src/lib/render/run-report'
import { defineMcpTool, textContent } from 'src/types'

import { convergeDependencies, probeDependencies } from './converge'
import type { SetupMode, ToolResult } from './converge'
import { reportHasFailure, toSetupReport } from './report'
import type { SetupReportInput } from './report'

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
  /** Portless-service seams for tests; production omits it and builds the real ones. */
  portlessDeps?: PortlessServiceDeps
  /** `--ascii`: render the report with ASCII markers instead of unicode glyphs. */
  ascii?: boolean
}

/**
 * Everything the portless-service step (§5.6 of the stable-path plan) needs: the `ensurePortlessLink`
 * seams to converge `~/.infra-kit/portless`, the `ensurePortlessNode` seams to converge `~/.infra-kit/node`
 * beside it, and doctor's `portless service target` seams to decide whether the installed system service
 * has caught up to both.
 *
 * The verdict is doctor's own ({@link portlessServiceTargetState}), not a second reading of the plist or
 * of the node file: two readers of one file can only ever disagree, and the sudo line is printed exactly
 * when doctor's row would not be a clean pass, through exactly the node doctor's row vouches for.
 */
export interface PortlessServiceDeps {
  link: EnsurePortlessLinkDeps
  node: EnsurePortlessNodeDeps
  target: ServiceTargetDeps
}

/**
 * The real seams: the link's and the node's from one `realPortlessStableDeps()` (a second evaluation of
 * `isGlobal` after the boot hook's — one `realpath` and one `.git` walk, nothing for a converge command),
 * plus doctor's defaults for the service-target row — all but one. The daemon-age seam is a no-op: that
 * row is doctor's restart advisory, never a `service install` verdict, and answering it spawns `ps`.
 * `setup` asks the file, not the process table.
 */
const realPortlessServiceDeps = (): PortlessServiceDeps => {
  const { link, node } = realPortlessStableDeps()

  return {
    link,
    node,
    target: {
      home: link.home,
      isGlobal: link.isGlobal,
      processStartTime: () => {
        return null
      },
    },
  }
}

/**
 * What the portless-service step did, for the `--json` payload. `service` is doctor's own verdict word, so
 * the payload and doctor's row can never name one state two ways; `'skipped'` means no portless to judge.
 */
interface PortlessServiceResult {
  link: PortlessLinkOutcome
  node: PortlessNodeResult['outcome']
  service: ServiceTargetState | 'skipped'
  /** The `service install` command a human has to run, exactly when `service` is `absent` or `drifted`. */
  command: string | null
}

/**
 * Converge `~/.infra-kit/portless` and `~/.infra-kit/node` and, when the installed system service (if
 * any) has not caught up to them, return the single `service install` command a human has to run — sudo
 * is never run here, and the command reaches the human as the service row's note in the report. This is
 * its own step, run unconditionally like the init half rather than gated on `--skip-tools`/`--tools`:
 * it is local and idempotent, not a network install of one of the six tracked tools.
 *
 * The line renders through the stable node only on doctor's health verdict (§5.4 N8 — resolved after
 * the converge, and from `execPath` even on a checkout's `'skipped-local'`, so the global's node still
 * shortens the line when it is the same inode): that verdict is the one surface that pays the spawn, so
 * a copy that does not run is never handed to root.
 */
const convergePortlessService = async (deps: PortlessServiceDeps): Promise<SetupReportInput['portless']> => {
  const link = ensurePortlessLink(deps.link).outcome
  const node = ensurePortlessNode(deps.node)
  const bin = portlessLinkCliPath(deps.link.home, deps.target.exists) ?? deps.link.resolveBin()

  if (bin === null) return { link, node, service: 'skipped', command: null }

  const { state, stableNode } = await portlessServiceTargetState(deps.target, bin)

  if (state === 'converged') return { link, node, service: state, command: null }

  const command = serviceInstallCommand(bin, {
    home: deps.link.home,
    exists: deps.target.exists,
    execPath: deps.target.execPath,
    stableNode,
  })

  return { link, node, service: state, command }
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

/**
 * Run the init half and report a throw as an entry instead of propagating it. Nothing is printed per
 * entry: the half is local and near-instant, so streaming it gives no progress signal, and the end
 * table already carries every step's verdict. Lines the libraries print themselves still stream.
 */
const runInitHalf = async (): Promise<InitEntry[]> => {
  const entries: InitEntry[] = []

  try {
    await initCore((entry) => {
      entries.push(entry)
    })
  } catch (err) {
    entries.push({
      step: failedStep(err, entries),
      outcome: 'failed',
      message: `The ${failedStep(err, entries)} step failed: ${err instanceof Error ? err.message : String(err)}`,
      level: 'warn',
    })
  }

  return entries
}

/**
 * One `failed` result per requested tool when the dependency half throws before it can report any of
 * them, so the table still prints and the run still exits 1 rather than dying without a report.
 */
const dependencyHalfFailed = (ids: readonly DependencyId[], err: unknown): ToolResult[] => {
  const reason = err instanceof Error ? err.message : String(err)

  return ids.map((id) => {
    return {
      id,
      action: 'failed',
      before: { present: false, onPath: false, version: null, manager: 'unknown' },
      commands: [],
      detail: `the dependency step failed before reaching this tool: ${reason}`,
    }
  })
}

const runDependencyHalf = async (request: ResolvedRequest, options: SetupOptions): Promise<ToolResult[]> => {
  try {
    return request.skipTools
      ? await probeDependencies(request.ids, options.probeDeps)
      : await convergeDependencies({
          ids: request.ids,
          mode: request.mode,
          probeDeps: options.probeDeps,
          run: options.run,
        })
  } catch (err) {
    return dependencyHalfFailed(request.ids, err)
  }
}

/** The `--json` payload carries the three declared keys and not the CLI's rendering hint. */
const toInitStep = (entry: InitEntry): InitStep => {
  return { step: entry.step, outcome: entry.outcome, message: entry.message }
}

export const setup = async (options: SetupOptions = {}) => {
  const request = resolveRequest(options)
  const init = await runInitHalf()
  const tools = await runDependencyHalf(request, options)
  const portless = await convergePortlessService(options.portlessDeps ?? realPortlessServiceDeps())
  const report = toSetupReport({ init, tools, portless }, { skipTools: request.skipTools })

  // Printed in EVERY mode, `--json` included: the setup skill always passes `--json` and its human reads
  // this table from the Bash result. stdout still carries only the JSON document.
  printRunReport({ title: 'infra-kit setup', sections: report }, { ascii: options.ascii })
  // Its own line after the table rather than a report hint: hints share the totals line, and this is
  // the one instruction that has to be read last.
  logger.info(SHELL_ACTIVATION_REMINDER)

  // Exit 1 iff any printed row failed, so the table and the exit code cannot disagree. `manual` never
  // counts: nothing failed, a human just has a command to run. The action owns the exit code because
  // nothing downstream reads the payload's booleans.
  if (reportHasFailure(report)) process.exitCode = 1

  const structuredContent = {
    init: init.map(toInitStep),
    tools,
    portlessService: {
      link: portless.link,
      node: portless.node.outcome,
      service: portless.service,
      command: portless.command,
    } satisfies PortlessServiceResult,
    report,
    converged: !request.skipTools,
    changed: tools.some((tool) => {
      return tool.action === 'installed' || tool.action === 'updated'
    }),
    allSucceeded: tools.every((tool) => {
      return tool.action !== 'failed'
    }),
  }

  return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
}

const initStepSchema = z.object({
  step: z
    .enum([
      'zshrc',
      'zshenv',
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
    .enum(['written', 'unchanged', 'skipped', 'manual', 'warned', 'failed'])
    .describe(
      'What that step did: changed something, found nothing to change, did not run, left a command for a human to run (the message carries it), failed non-fatally, or threw and ended the init half (setup exits 1)',
    ),
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

const portlessServiceSchema = z.object({
  link: z
    .enum(['created', 'repointed', 'unchanged', 'skipped-local', 'skipped-unresolved', 'failed'])
    .describe('What the ~/.infra-kit/portless link step did'),
  node: z
    .enum(['created', 'refreshed', 'unchanged', 'skipped-local', 'skipped-platform', 'failed'])
    .describe('What the ~/.infra-kit/node step did'),
  service: z
    .enum(['absent', 'converged', 'drifted', 'skipped'])
    .describe(
      'The installed portless system service against the link and node: not installed, already running through both, installed but pointing elsewhere, or not judged because portless is not installed',
    ),
  command: z
    .string()
    .nullable()
    .describe(
      'The sudo `service install` command a human has to run; present if and only if service is absent or drifted, null otherwise',
    ),
})

const outputSchema = {
  init: z.array(initStepSchema).describe('One entry per init step, in the order they ran'),
  tools: z.array(resultSchema).describe('One result per requested dependency'),
  portlessService: portlessServiceSchema.describe(
    'The portless link, node, and system-service step — run on every setup, never gated on the tool options',
  ),
  converged: z.boolean().describe('Whether the dependency step could act at all (false under skipTools)'),
  changed: z.boolean().describe('Whether anything was installed or updated'),
  report: z
    .array(
      z.object({
        label: z.string().describe('Section heading'),
        rows: z.array(
          z.object({
            name: z.string().describe('Init step, tool id, or portless part'),
            status: z
              .enum(['ok', 'changed', 'skipped', 'manual', 'warn', 'fail'])
              .describe(
                'ok: nothing to change; changed: changed something; skipped: did not run; manual: not run by the CLI, the notes hold the command a human runs; warn: advisory problem; fail: failed (setup exits 1)',
              ),
            message: z.string().describe('The row message, as printed'),
            notes: z
              .array(z.string())
              .optional()
              .describe('Lines printed under the row, verbatim: the manual commands, warnings and failures'),
          }),
        ),
      }),
    )
    .describe('The exact rows of the table printed on stderr; setup exits 1 iff a row is fail'),
  allSucceeded: z.boolean().describe('Whether no tool failed (a refusal is not a failure)'),
}

const inputSchema = {
  tools: z
    .array(z.enum(DEPENDENCY_IDS as [DependencyId, ...DependencyId[]]))
    .optional()
    .describe('Which tools to act on. Omit for all six.'),
  mode: z
    .enum(['converge', 'update'])
    .optional()
    .describe('converge (default): install what is missing and update the rest. update: never install.'),
  skipTools: z
    .boolean()
    .optional()
    .describe('Read-only: run the init half, then REPORT what each tool needs without installing anything.'),
}

// `requiresHumanConfirm` is required for every mutating tool (`command-catalog.test.ts`) and does not
// substitute for the computed refusal in `lib/dependency-install/risk-predicate`, the only control that
// holds regardless of how the CLI is invoked. The read path that raises no prompt is `doctor` — a
// separate command, therefore a separate permission identity, which is why the two are not one tool.
export const setupMcpTool = defineMcpTool({
  name: 'setup',
  description:
    'Set this machine up in one call: inject the shell integration into .zshrc and the session-env block into .zshenv, run the config migrations, seed the user-global config, refresh the agent-instruction files, register the Claude Code plugin pointer and install or update the skills plugin (the `/infra-kit:*` skills drive the infra-kit CLI on PATH; a leftover .mcp.json entry is reported, never written), then bring brew, git, aws, gh, doppler and portless to a working state — installing what is missing and updating what is present. Pass mode:"update" to update only and never install, or skipTools:true to do the local setup and then REPORT what each tool needs without installing anything. Recipes that need sudo or pipe a script fetched over the network — the Homebrew bootstrap and the first AWS CLI install — are never run; they are reported with the exact commands for you to run yourself. Use `doctor` first to see the state of this machine without changing it.',
  inputSchema,
  outputSchema,
  requiresHumanConfirm: true,
  handler: (params: { tools?: DependencyId[]; mode?: SetupMode; skipTools?: boolean }) => {
    return setup({ tools: params.tools, update: params.mode === 'update', skipTools: params.skipTools })
  },
})
