import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import type { GuidanceWrite } from 'src/lib/agent-guidance'
import { seedCreatedMessage, seedUserProjectConfig } from 'src/lib/config-bootstrap'
import { CONFIG_STUB, buildUserGlobalExample, buildVendorExample } from 'src/lib/config-templates'
import { getInfraKitConfig, getInfraKitConfigPaths } from 'src/lib/infra-kit-config'
import { fallbackUpdateCommand, formatUpdateCommand } from 'src/lib/install-manager'
import { logger } from 'src/lib/logger'
import { removeManagedBlock, upsertManagedBlock } from 'src/lib/managed-block'
import {
  MARKETPLACE_ADD_COMMAND,
  MARKETPLACE_NAME,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_KEY,
  PLUGIN_UPDATE_COMMAND,
  ensurePluginPointer,
  inspectLegacyMcpRegistration,
  installPluginForProject,
  resolvePluginInstall,
} from 'src/lib/plugin-pointer'
import type { McpRegistration, PluginInstallOutcome, PluginPointerResult } from 'src/lib/plugin-pointer'
import { reconcileMcpProxies } from 'src/lib/plugin-pointer/mcp-proxy-registration'
import type { McpProxyReconcileResult } from 'src/lib/plugin-pointer/mcp-proxy-registration'
import { MCP_FILE_NAME, SERVERS_KEY } from 'src/lib/plugin-pointer/mcp-registration'
import { fetchLatestVersion, pluginStepWithheld, readUpdateCache } from 'src/lib/update-check'

import packageJson from '../../../package.json' with { type: 'json' }
import { resolveGitRootForWrites, syncRepoGuidance } from './agent-files'
import {
  migrateCmuxConfigToOrca,
  migrateFactoryConfigToJson,
  migrateLegacyConfig,
  migrateUserGlobalConfigFilename,
  normalizeLegacyIdeStructures,
} from './migrate-config'

export const MARKER_START = '# -- infra-kit:begin --'
export const MARKER_END = '# -- infra-kit:end --'

const LEGACY_PAIRED: [start: string, end: string][] = [['# region infra-kit', '# endregion infra-kit']]
const LEGACY_SINGLE = '# infra-kit shell functions'

/** Which of `initCore`'s steps an {@link InitStep} reports on. */
export type InitStepName =
  | 'guidance'
  | 'mcp-proxies'
  | 'mcp-server'
  | 'migrations'
  | 'plugin-pointer'
  | 'project-config'
  | 'shell'
  | 'user-config'
  | 'zshrc'
  | 'zshenv'

/**
 * What a step did.
 *
 * `written` changed something; `unchanged` ran and found nothing to change; `skipped` did not run, or
 * reports through another channel (the migrators and both `agent-files` gates print their own lines);
 * `warned` is a best-effort failure that did not stop the run.
 */
export type InitOutcome = 'skipped' | 'unchanged' | 'warned' | 'written'

/**
 * One reportable thing `initCore` did, in the order it did it.
 *
 * Required rather than cosmetic: a `--json` caller reads stdout alone, so a `setup` reporting only
 * through `logger` (stderr) would perform ~8 local writes and hand the agent nothing about any of them.
 */
export interface InitStep {
  step: InitStepName
  outcome: InitOutcome
  message: string
}

/**
 * How the CLI prints an entry — carried rather than derived from `outcome`, because the two disagree:
 * a guidance file whose write FAILED prints at `info` (it is one row of a per-file list) while the
 * "N files could not be written" summary prints at `warn`. Deriving the level from the outcome would
 * move one of those lines to another stream, which is exactly the byte difference this refactor may
 * not introduce.
 *
 * `silent` lands in the `--json` report and prints nothing, because the library that performed the
 * step already printed its own line — printing here would double every one of them.
 */
type InitLevel = 'debug' | 'info' | 'silent' | 'warn'

export interface InitEntry extends InitStep {
  level: InitLevel
}

export type InitReport = InitEntry[]

/** Notified as each entry happens, so a caller prints in step order instead of in a trailing block. */
export type InitStepSink = (entry: InitEntry) => void

/** `initCore`'s internal accumulator, handed to the steps that must report as they go. */
type InitStepRecorder = (...entries: InitEntry[]) => void

/**
 * Tags a throwing step with the step it threw in.
 *
 * The tag exists for `setup`, the only caller: it catches this, records the step as `warned`, and goes
 * on to its dependency half rather than losing the run to one failed local write. Nothing unwraps it
 * back to the bare reason any more — the standalone command that used to do that is gone — so a caller
 * that lets it escape surfaces the step name too, which is strictly more than the old CLI printed.
 */
export class InitStepError extends Error {
  constructor(
    readonly step: InitStepName,
    readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason), { cause: reason })
    this.name = 'InitStepError'
  }
}

/**
 * `initCore`'s closing line.
 *
 * Exported so `setup` can hold this ONE entry back and print it after its dependency half, which is
 * where the reminder belongs when both halves run — without pattern-matching a message it does not own.
 */
export const SHELL_ACTIVATION_REMINDER = 'Run `source ~/.zshrc` or open a new terminal to activate.'

/** The five migrations announce their own conversions, so this step has nothing of its own to print. */
const MIGRATIONS_CHECKED: InitEntry = {
  step: 'migrations',
  outcome: 'skipped',
  message:
    'Config migrations checked (legacy yml layers, ide structure, user-global filename, cmux → orca keys, factory config)',
  level: 'silent',
}

/** Run one step, tagging anything it throws with which step it was. */
const withStep = async <T>(step: InitStepName, body: () => Promise<T> | T): Promise<T> => {
  try {
    return await body()
  } catch (err) {
    throw new InitStepError(step, err)
  }
}

/**
 * Append infra-kit shell functions to .zshrc, migrate any legacy `infra-kit.yml`
 * config layers to JSON, normalize existing JSON configs from the old IDE structure
 * (strip the removed `ide.config.mode`), convert a legacy factory `vendor.config.ts`
 * to `vendor.json`, and seed the user-global config at ~/.infra-kit/infra-kit.json on
 * first run.
 *
 * Idempotent: a subsequent run replaces the existing zshrc block in place,
 * has nothing left to migrate or normalize, and leaves the REAL config files
 * (infra-kit.json / vendor.json) untouched — but the annotated `.example.jsonc`
 * reference files are refreshed on every run so they always reflect the current schema.
 *
 * Returns the report; `onStep` is notified as each entry happens.
 *
 * @example
 * // CLI: `infra-kit setup --skip-tools` (the additive half on its own; flagless `setup` runs it too)
 * // INFO: Added infra-kit shell functions to /Users/me/.zshrc
 * // INFO: Wrote user-global config to /Users/me/.infra-kit/infra-kit.json (see …/infra-kit.example.jsonc …)
 * // INFO: Run `source ~/.zshrc` or open a new terminal to activate.
 */
// Why both a return value AND a sink: the return value is what a `--json` caller reads, and the streaming
// sink is what keeps the CLI's lines interleaved with the ones its libraries print (`✓ Migrated …`, the
// two skip announcements) exactly where they have always been. A trailing replay would reorder them.
export const initCore = async (onStep?: InitStepSink): Promise<InitReport> => {
  const report: InitReport = []
  const record = (...entries: InitEntry[]): void => {
    for (const entry of entries) {
      report.push(entry)
      onStep?.(entry)
    }
  }

  await withStep('zshrc', () => {
    record(writeShellBlock())
  })

  await withStep('zshenv', () => {
    record(writeZshenvBlock())
  })

  await withStep('migrations', async () => {
    await runConfigMigrations()
    record(MIGRATIONS_CHECKED)
  })

  await withStep('user-config', () => {
    record(seedUserGlobalConfig())
  })

  // Best-effort, non-fatal, repo-gated: keep the agent-instruction files in sync
  // with the CLI surface — root AND every workspace package. A no-op outside an
  // infra-kit repo (gated on `resolveInfraKitRoot`: the blocks render config-derived
  // content, so `infra-kit.json` is a real precondition for THEM).
  const guidanceRoot = await withStep('guidance', async () => {
    const { entries, root } = await syncAgentGuidance()

    record(...entries)

    return root
  })

  // A SEPARATE, weaker gate for the plugin steps: they write `.claude/settings.json`,
  // drive `claude plugin install` and read `.mcp.json`, and none of the three reads
  // `infra-kit.json` — so gating them on it was incidental coupling that made a fresh
  // repo impossible to set up. One `resolveGitRootForWrites` for all three, because
  // `syncPluginPointer`'s contract binds pointer ↔ installation ↔ leftover-key verdict to ONE
  // project: `--scope project` must record exactly what the pointer names.
  //
  // The announcing variant, and this is the ONLY call to it: the four-step skip is `initCore`'s line
  // to print, so the bare predicate stays silent for `doctor`, which only reads it.
  const gitRoot = await withStep('plugin-pointer', async () => {
    return resolveGitRootForWrites()
  })

  record(...gateDisagreementEntries(gitRoot, guidanceRoot))

  await withStep('plugin-pointer', async () => {
    await syncPluginPointer(gitRoot, record)
  })

  await withStep('mcp-proxies', async () => {
    record(...(await syncMcpProxies(gitRoot)))
  })

  // Close the legacy-yml migration gap so a single `dx-init` leaves EVERY example current.
  await withStep('project-config', async () => {
    record(...(await reseedUserProjectConfig()))
  })

  record(...shellEntries())

  return report
}

/**
 * The one place an {@link InitEntry} becomes a log line.
 *
 * Exported for `setup`, which prints the same half with the same words — a second renderer there would
 * be a second set of strings to keep in step with this one.
 */
export const logInitEntry = (entry: InitEntry): void => {
  if (entry.level === 'silent') return

  if (entry.level === 'warn') {
    logger.warn(entry.message)

    return
  }

  if (entry.level === 'debug') {
    logger.debug({ msg: entry.message })

    return
  }

  logger.info(entry.message)
}

/**
 * Strip any prior block (current or legacy markers) anywhere in the file, then append a fresh block at
 * end-of-file via the shared managed-block utility — the historical `removeExistingBlock` + append
 * behavior, now centralized.
 */
const writeShellBlock = (): InitEntry => {
  const zshrcPath = path.join(os.homedir(), '.zshrc')
  const existing = fs.existsSync(zshrcPath) ? removeExistingBlock(fs.readFileSync(zshrcPath, 'utf-8')) : ''

  const updated = upsertManagedBlock({
    content: existing,
    body: buildShellBody(),
    startMarker: MARKER_START,
    endMarker: MARKER_END,
    placement: 'append-end',
  })

  fs.writeFileSync(zshrcPath, updated)

  return {
    step: 'zshrc',
    outcome: 'written',
    message: `Added infra-kit shell functions to ${zshrcPath}`,
    level: 'info',
  }
}

/**
 * Upsert the session-env block in `~/.zshenv`. Unlike {@link writeShellBlock} there is no legacy
 * strip — `.zshenv` never carried an infra-kit block — and placement is the default replace-in-place:
 * a first install lands at end-of-file, so a user's own `export XDG_CACHE_HOME=…` above it is
 * honoured, and later runs keep whatever position the user moved it to.
 */
const writeZshenvBlock = (): InitEntry => {
  const zshenvPath = path.join(os.homedir(), '.zshenv')
  const existing = fs.existsSync(zshenvPath) ? fs.readFileSync(zshenvPath, 'utf-8') : ''

  const updated = upsertManagedBlock({
    content: existing,
    body: buildZshenvBody(),
    startMarker: MARKER_START,
    endMarker: MARKER_END,
  })

  fs.writeFileSync(zshenvPath, updated)

  return {
    step: 'zshenv',
    outcome: 'written',
    message: `Added infra-kit session-env block to ${zshenvPath}`,
    level: 'info',
  }
}

/** The five config migrations, in the one order that works. */
const runConfigMigrations = async (): Promise<void> => {
  // Convert any legacy infra-kit.yml config layers to JSON before seeding, so a
  // migrated infra-kit.json is not re-seeded as an empty stub.
  await migrateLegacyConfig()

  // Migrate existing JSON configs from the old IDE structure to the new one
  // (strip the removed `ide.config.mode` field). No-op for already-clean configs.
  await normalizeLegacyIdeStructures()

  // Rename a legacy user-global config.json → infra-kit.json (single canonical
  // filename). MUST run before seeding: otherwise the seeder checks the new name,
  // doesn't find it, and writes an empty stub that shadows the user's real config.
  await migrateUserGlobalConfigFilename()

  // Rewrite the legacy cmux keys to orca. AFTER the filename rename: outside a
  // project it addresses ~/.infra-kit/infra-kit.json by that fixed name.
  await migrateCmuxConfigToOrca()

  // Convert a legacy machine-local factory config from executable TS
  // (~/.infra-kit/vendor.config.ts) to static JSON (~/.infra-kit/vendor.json).
  // Independent of the infra-kit.json layers; grouped with the other migrations.
  await migrateFactoryConfigToJson()
}

/**
 * The shell integration is zsh-only (zmodload zsh/stat, add-zsh-hook, ${dir:h}), so a non-zsh login
 * shell is warned about non-fatally rather than left with a silent no-op block.
 */
const shellEntries = (): InitEntry[] => {
  const shell = process.env.SHELL ?? ''
  const entries: InitEntry[] = []

  if (!shell.includes('zsh')) {
    entries.push({
      step: 'shell',
      outcome: 'warned',
      message: `Your login shell ($SHELL=${shell || 'unset'}) is not zsh. The infra-kit shell integration (env-load/env-clear/auto-load) is zsh-only and won't activate in bash/fish.`,
      level: 'warn',
    })
  }

  // `unchanged` because that is what it reports: the running shell keeps its old environment until the
  // user sources the file this run just wrote.
  entries.push({ step: 'shell', outcome: 'unchanged', message: SHELL_ACTIVATION_REMINDER, level: 'info' })

  return entries
}

/**
 * Seed the user-global config on first run and (re)write the annotated reference
 * files. The real `~/.infra-kit/infra-kit.json` (empty `{}`) is written only when
 * absent so user edits are preserved. The non-loaded `.example.jsonc` reference
 * files (`infra-kit.example.jsonc` + `vendor.example.jsonc`) are rewritten on EVERY
 * run so existing users always get the current, complete schema documentation.
 *
 * Deliberately seeds NO real `vendor.json` — that is scaffolded by
 * `infra-kit vendor config --init` (a stub here would block `--init`, trip the
 * factory migration's no-overwrite guard, and fail the schema's `targets.min(1)`).
 *
 * @example
 * seedUserGlobalConfig()
 * // first call:  writes ~/.infra-kit/infra-kit.json ({}) + both .example.jsonc files
 * // later calls: leaves infra-kit.json alone, refreshes both .example.jsonc files
 */
export const seedUserGlobalConfig = (): InitEntry => {
  const userConfigDir = path.join(os.homedir(), '.infra-kit')
  const userConfigPath = path.join(userConfigDir, 'infra-kit.json')

  fs.mkdirSync(userConfigDir, { recursive: true })

  // Reference examples are non-loaded docs — always refresh them so re-running init
  // delivers the current schema (and the newly-added vendor example) to existing users.
  fs.writeFileSync(path.join(userConfigDir, 'infra-kit.example.jsonc'), buildUserGlobalExample(), 'utf-8')
  fs.writeFileSync(path.join(userConfigDir, 'vendor.example.jsonc'), buildVendorExample(), 'utf-8')

  if (fs.existsSync(userConfigPath)) {
    return {
      step: 'user-config',
      outcome: 'unchanged',
      message: `User-global config already present at ${userConfigPath} (refreshed reference examples)`,
      level: 'info',
    }
  }

  fs.writeFileSync(userConfigPath, CONFIG_STUB, 'utf-8')

  return {
    step: 'user-config',
    outcome: 'written',
    message: `Wrote user-global config to ${userConfigPath} (see the sibling .example.jsonc files for reference)`,
    level: 'info',
  }
}

/**
 * Re-run the layer-3 seed at the END of `initCore`, closing the legacy-yml migration gap.
 *
 * Re-evaluates the preAction gate itself and drives the UNGATED `seedUserProjectConfig`, so it
 * honours `INFRA_KIT_NO_SEED` by hand. Any failure (no git repo, no project config, an unwritable
 * `$HOME`) degrades to a debug line — seeding a reference file must never fail `initCore`. Separate
 * from {@link seedUserGlobalConfig}, which keeps its layer-2-only duty and stays sync.
 *
 * @example
 * await reseedUserProjectConfig()
 * // after a legacy infra-kit.yml migration:
 * // INFO: Created ~/.infra-kit/projects/api/infra-kit.json — see …/infra-kit.example.jsonc …
 */
// Why this exists at all: the per-command seed lives in the program's preAction hook, which
// evaluates its "is this an infra-kit repo?" gate (does `<repo-root>/infra-kit.json` exist?)
// BEFORE the action body runs. On the legacy-yml migration path `initCore` itself CREATES that file
// (`migrateLegacyConfig`), so the gate had already declined and this very run would otherwise
// leave the layer-3 example unwritten — self-healing only on the user's next command. Re-running
// the gate here makes one `dx-init` enough.
//
// Why the ungated primitive: `ensureUserProjectConfig()` is an ENTRY-BOUNDARY primitive whose
// once-per-process guard has ALREADY fired in preAction, so calling it here would be a silent
// no-op — unusable as a re-seed hook. Its ungated replacement does not read `INFRA_KIT_NO_SEED`,
// so without the check above the kill switch would be airtight on every path EXCEPT `initCore`.
const reseedUserProjectConfig = async (): Promise<InitEntry[]> => {
  if (process.env.INFRA_KIT_NO_SEED) return [projectConfigSkip('INFRA_KIT_NO_SEED is set')]

  try {
    const paths = await getInfraKitConfigPaths()

    // The same D2 gate the preAction seed applies — re-evaluated now that the migrations have run.
    if (!fs.existsSync(paths.main)) return [projectConfigSkip(`no project config at ${paths.main}`)]

    const result = await seedUserProjectConfig(paths)

    if (!result.createdConfig) return [projectConfigSkip('the user-project config was already present')]

    return [{ step: 'project-config', outcome: 'written', message: seedCreatedMessage(result), level: 'info' }]
  } catch (err) {
    // Kept as a raw logger call rather than routed through an entry: the `err` OBJECT is the whole point
    // of this line, and an entry carries a message string. The entry beside it reports the outcome.
    logger.debug({ err, msg: 'Skipped seeding the user-project config (init).' })

    return [projectConfigSkip(err instanceof Error ? err.message : String(err))]
  }
}

/** Every reason the layer-3 reseed does nothing is silent on the CLI, exactly as it has always been. */
const projectConfigSkip = (why: string): InitEntry => {
  return {
    step: 'project-config',
    outcome: 'skipped',
    message: `Skipped seeding the user-project config — ${why}`,
    level: 'silent',
  }
}

/**
 * Log one line per guidance file this run actually changed, then the step's closing line.
 *
 * Unchanged files are omitted: a repo-wide refresh touches every package, and a clean
 * re-run would otherwise print one no-op line per package on top of `initCore`'s other output.
 *
 * When any file failed, a distinct summary line names the count and the fix. `initCore` exits 0
 * regardless (its contract is shell setup, and the sync is a side effect that must not turn
 * a machine-setup command red), which makes this line the only signal a partial sync
 * happened — so it must not be a per-path line buried among the rest.
 */
const guidanceEntries = (root: string, version: string, written: GuidanceWrite[]): InitEntry[] => {
  const entries: InitEntry[] = []

  for (const file of written) {
    if (file.action === 'unchanged') continue

    const suffix = file.type === undefined ? '' : ` (${file.type})`

    entries.push({
      step: 'guidance',
      // A failed row is still one line of the per-file list, so it prints at `info` like its siblings —
      // the level and the outcome part company here, which is why the entry carries both.
      outcome: file.action === 'failed' ? 'warned' : 'written',
      message: `  ${file.action.padEnd(9)} ${path.relative(root, file.path)}${suffix}`,
      level: 'info',
    })
  }

  entries.push({
    step: 'guidance',
    outcome: 'written',
    message: `Agent-instruction files synced (infra-kit ${version})`,
    level: 'info',
  })

  const failed = written.filter((file) => {
    return file.action === 'failed'
  })

  if (failed.length === 0) return entries

  entries.push({
    step: 'guidance',
    outcome: 'warned',
    message: `${failed.length} package guidance files could not be written — run: infra-kit audit --fix --all`,
    level: 'warn',
  })

  return entries
}

/**
 * `initCore`'s agent-guidance step: refresh the root block AND every workspace package's block in
 * one pass, then report. Continue-and-report — `syncRepoGuidance` never throws, a per-file
 * error arrives as `action: 'failed'`, and `process.exitCode` is deliberately left untouched
 * so `initCore` goes on to its remaining steps. A user who wants a failure to be an error runs
 * `infra-kit audit --fix --all`, which does exit non-zero.
 *
 * @example
 * await syncAgentGuidance()
 * // INFO:   updated   CLAUDE.md
 * // INFO:   created   apps/client/ui/CLAUDE.md (frontend)
 * // INFO: Agent-instruction files synced (infra-kit 0.4.0)
 */
const syncAgentGuidance = async (): Promise<{ root: string | null; entries: InitEntry[] }> => {
  const { skipped, root, version, written } = await syncRepoGuidance()

  if (skipped || root === null) {
    // Silent: `resolveInfraKitRoot` has already printed the reason it declined.
    return {
      root: null,
      entries: [
        {
          step: 'guidance',
          outcome: 'skipped',
          message: 'Agent-instruction files skipped — not an infra-kit repo',
          level: 'silent',
        },
      ],
    }
  }

  return { root, entries: guidanceEntries(root, version, written) }
}

/** One line per pointer outcome. `unparseable` already warned from inside the lib, so it says nothing here. */
const pointerEntry = (root: string, result: PluginPointerResult): InitEntry => {
  const relative = path.relative(root, result.path)

  if (result.status === 'created') {
    return {
      step: 'plugin-pointer',
      outcome: 'written',
      message: `  created   ${relative} (Claude Code plugin pointer)`,
      level: 'info',
    }
  }

  if (result.status === 'added') {
    return {
      step: 'plugin-pointer',
      outcome: 'written',
      message: `  updated   ${relative} — added ${result.added.join(', ')}`,
      level: 'info',
    }
  }

  return {
    step: 'plugin-pointer',
    outcome: result.status === 'unchanged' ? 'unchanged' : 'warned',
    message: `${relative} — ${result.status}`,
    level: 'silent',
  }
}

/**
 * One line per `.mcp.json` verdict — a READ, never a write. The plugin is skills-only and the skills
 * drive the CLI over Bash, so `setup` registers no server; it reports what the repo's own file says.
 *
 * `stale` is `unchanged` at `info`, not `warned`: the leftover key spawns the retired `mcp` stub, which
 * exits at once, so the session shows one failed MCP row — a pending repo chore with no deadline: the
 * line names it and says what to delete. `wrong-key`
 * is the same chore under another key, at `info` too, naming the key. `absent` / `missing-file` are
 * the steady state and say so, so a reader who knew the old "created .mcp.json" line learns the entry
 * is not wanted any more. `unparseable` is the one fault and WARNS with the fix: the lib no longer
 * logs, so this is the only place it is audible.
 */
const mcpEntry = (root: string, registration: McpRegistration): InitEntry => {
  const relative = MCP_FILE_NAME

  if (registration.kind === 'stale' || registration.kind === 'wrong-key') {
    const key = registration.kind === 'stale' ? MARKETPLACE_NAME : registration.key

    return {
      step: 'mcp-server',
      outcome: 'unchanged',
      message: `  ${relative} still registers the infra-kit MCP server under "${key}" — the plugin no longer serves one, so this entry only spawns a compatibility stub. Delete the "${key}" entry from ${relative} by hand in a PR, keeping its siblings`,
      level: 'info',
    }
  }

  if (registration.kind === 'unparseable') {
    return {
      step: 'mcp-server',
      outcome: 'warned',
      message: `Could not read ${SERVERS_KEY} from ${path.join(root, MCP_FILE_NAME)} — fix the JSON and re-run: infra-kit setup --skip-tools`,
      level: 'warn',
    }
  }

  const carries = registration.kind === 'absent' ? `${relative} carries no "${MARKETPLACE_NAME}" key` : `no ${relative}`

  return {
    step: 'mcp-server',
    outcome: 'unchanged',
    message: `  infra-kit MCP server: none wanted — the plugin is skills-only (${carries})`,
    level: 'info',
  }
}

/**
 * Announce the one state where the two gates disagree: a git root resolved, but no
 * `infra-kit.json` at it.
 *
 * This is the ONLY protection that exists there. `initCore` takes no arguments, and `setup`'s three
 * flags all narrow the DEPENDENCY half, so there is nothing here that could offer an
 * "outside an infra-kit repo" confirmation, and it must not prompt because non-TTY runs skip
 * prompts silently — so a run whose cwd is inside a stranger's project would otherwise write
 * three tracked files, print its success line and exit 0, surfacing later as an unexplained diff.
 *
 * It names the ABSOLUTE root rather than "this repo" because the whole failure mode is a caller
 * who is somewhere other than they think. That is truthful only because `resolveGitRoot` rejects a
 * blank resolve: `''` would reach this branch and announce the wrong path while the writers below
 * targeted `process.cwd()`.
 */
const gateDisagreementEntries = (gitRoot: string | null, guidanceRoot: string | null): InitEntry[] => {
  if (gitRoot === null || guidanceRoot !== null) return []

  return [
    {
      step: 'plugin-pointer',
      outcome: 'warned',
      message: `No infra-kit.json at ${gitRoot} — setting up Claude Code there anyway: writing .claude/settings.json and installing the ${PLUGIN_KEY} plugin for that project. If that is not the repo you meant to set up, revert that file and uninstall the plugin.`,
      level: 'warn',
    },
  ]
}

/** The two commands, in order, that a person runs by hand when `initCore` could not run them. */
const manualInstallEntries = (): InitEntry[] => {
  return [MARKETPLACE_ADD_COMMAND, PLUGIN_INSTALL_COMMAND].map((command) => {
    return { step: 'plugin-pointer', outcome: 'skipped', message: command, level: 'info' }
  })
}

/**
 * The withheld update, as one WARN line the reader can act on: the version they are behind and the
 * command that closes the gap. `outcome: 'skipped'` — nothing failed, the step chose not to run.
 *
 * The installer reports `skipped-cli-stale` only when the `cliIsStale` thunk it was handed returned
 * true, and that thunk reads `staleness.stale`; the non-stale arm exists for the type, not for a path.
 */
const cliStaleEntry = (staleness: CliStaleness): InitEntry => {
  const detail = staleness.stale
    ? `CLI ${packageJson.version} is behind ${staleness.latestVersion}, update it first: ${formatUpdateCommand(staleness.updateCommand)}`
    : `CLI ${packageJson.version} is behind the published version, update it first`

  return {
    step: 'plugin-pointer',
    outcome: 'skipped',
    message: `Claude Code plugin not updated — ${detail}. The plugin follows on the next update check after that.`,
    level: 'warn',
  }
}

/**
 * One line per install outcome.
 *
 * `updated` is the steady state of a configured machine and still prints at INFO: unlike the old
 * "already installed" no-op it reports something that RAN — `claude plugin update` — and that line is
 * the only place a person learns `setup` is how a plugin bump reaches their machine. The failure
 * outcomes are WARN and carry the step, the tool's own first line, and the command to run instead —
 * a warning a reader cannot act on is noise.
 */
const installEntries = (outcome: PluginInstallOutcome, staleness: CliStaleness): InitEntry[] => {
  if (outcome.status === 'skipped-cli-stale') return [cliStaleEntry(staleness)]

  if (outcome.status === 'updated') {
    return [
      {
        step: 'plugin-pointer',
        outcome: 'unchanged',
        message: `Claude Code plugin ${PLUGIN_KEY} up to date (project scope)`,
        level: 'info',
      },
    ]
  }

  if (outcome.status === 'update-failed') {
    return [
      {
        step: 'plugin-pointer',
        outcome: 'warned',
        message: `Could not update the Claude Code plugin — ${outcome.error}. Run by hand: ${PLUGIN_UPDATE_COMMAND}`,
        level: 'warn',
      },
    ]
  }

  if (outcome.status === 'installed') {
    return [
      {
        step: 'plugin-pointer',
        outcome: 'written',
        message: `installed Claude Code plugin ${PLUGIN_KEY} (project scope)`,
        level: 'info',
      },
    ]
  }

  if (outcome.status === 'claude-missing') {
    return [
      {
        step: 'plugin-pointer',
        outcome: 'skipped',
        message: 'No `claude` on PATH, so the Claude Code plugin was not installed. Install Claude Code, then run:',
        level: 'info',
      },
      ...manualInstallEntries(),
    ]
  }

  const reason =
    outcome.status === 'unverified'
      ? 'the install reported success but Claude Code recorded no installation'
      : `the ${outcome.step} step failed: ${outcome.error}`

  return [
    {
      step: 'plugin-pointer',
      outcome: 'warned',
      message: `Could not install the Claude Code plugin — ${reason}. Run by hand: ${PLUGIN_INSTALL_COMMAND}`,
      level: 'warn',
    },
  ]
}

/** What `resolveCliStaleness` found: a newer CLI this machine has not installed, or nothing to withhold for. */
type CliStaleness = { stale: false } | { stale: true; latestVersion: string; updateCommand: string[] }

const NOT_STALE: CliStaleness = { stale: false }

/**
 * Is a newer CLI published than the one running `setup`? The same predicate the update worker applies
 * before its own plugin step (`pluginStepWithheld`), read from the same cache — so `setup` cannot run
 * the plugin ahead of the CLI on a machine the worker refuses to.
 *
 * The cache read lives HERE, in `commands/`, and not in `install-plugin.ts`: `lib/update-check` already
 * imports `lib/plugin-pointer` (`update-plugin.ts` → `install-state`), so the reverse import would be
 * a cycle. No cache means an opt-out machine (`OPT_OUT_ENV_VARS` — the worker never runs there, so it
 * never writes one), and `setup` is interactive: one bounded registry fetch is affordable. A fetch that
 * fails is unknowable, exactly like the worker's `fetch-failed`, and withholds nothing.
 *
 * @example
 * await resolveCliStaleness() // => { stale: true, latestVersion: '0.8.0', updateCommand: ['npm', …] }
 */
const resolveCliStaleness = async (): Promise<CliStaleness> => {
  const cache = readUpdateCache()
  const latestVersion = cache === null ? await fetchLatestVersion(process.env) : cache.latestVersion

  if (latestVersion === null || !pluginStepWithheld(latestVersion, packageJson.version)) return NOT_STALE

  // The worker's verdict when it has one (`cannot-self-spawn` records the manager-specific command);
  // otherwise the same guess it records for an unrecognised location.
  return { stale: true, latestVersion, updateCommand: cache?.updateCommand ?? fallbackUpdateCommand(latestVersion) }
}

/**
 * Point this repo's Claude Code at the infra-kit plugin marketplace, INSTALL (or update) the plugin
 * so a teammate's whole setup is one command, then report what the repo's own `.mcp.json` says about
 * the retired MCP server (a leftover key is a chore to delete, never a write).
 *
 * The pointer write and the install are driven from ONE root — `resolveGitRoot`'s, no longer the
 * guidance sync's — so the pointer keys and what `--scope project` records name a single project,
 * and the `.mcp.json` read answers about that same project. That binding is the contract here; which
 * predicate produced the root is not.
 *
 * There is deliberately NO opt-out flag. The install is idempotent (an already-installed plugin runs
 * only the idempotent `plugin update`) and best-effort (every failure is a logged outcome, never a
 * thrown error), so a switch would only buy a way to end up with the pointer keys pointing at a
 * plugin nobody has.
 */
const syncPluginPointer = async (root: string | null, record: InitStepRecorder): Promise<void> => {
  if (root === null) {
    // Silent: `resolveGitRootForWrites` has already printed the four-step skip.
    record({
      step: 'plugin-pointer',
      outcome: 'skipped',
      message: 'Claude Code plugin steps skipped — no git root safe to write into',
      level: 'silent',
    })

    return
  }

  try {
    // Recorded one at a time rather than returned as an array: the pointer library logs its own
    // refusals, and a batched return would print `initCore`'s lines after the libraries' — reordering
    // output that a partial failure makes visible.
    record(pointerEntry(root, ensurePluginPointer(path.join(root, '.claude', 'settings.json'))))

    // Resolved ahead of the (synchronous) installer, and only when there is an update to withhold: a
    // fresh install has nothing to gate, and an opt-out machine without the plugin must not pay a
    // registry fetch for a question nobody asked.
    const installed = resolvePluginInstall({ projectPath: root }).kind === 'installed'
    const staleness = installed ? await resolveCliStaleness() : NOT_STALE

    record(
      ...installEntries(
        installPluginForProject({
          projectRoot: root,
          cliIsStale: () => {
            return staleness.stale
          },
        }),
        staleness,
      ),
    )

    // AFTER the install so the report reads in cause order: the skills are what an agent uses now,
    // and the `.mcp.json` read is about a leftover the skills no longer need. It writes nothing in
    // any branch — the retired writer used to re-add the key here, which on a repo that had
    // deliberately deleted it meant a dirty tracked file (archived plan §4 PM-9).
    record(mcpEntry(root, inspectLegacyMcpRegistration(root)))
  } catch (err) {
    // Best-effort — neither an unwritable `.claude/settings.json`, a hand-broken
    // `~/.claude/plugins/installed_plugins.json`, nor a `claude` binary that throws on spawn may turn
    // a machine-setup command red. But WARN, not debug: `initCore` goes on to print its success line and
    // exit 0, so at `debug` a read-only settings file or a `.mcp.json` that is a directory failed with
    // no output at all. The error text carries the offending path; the root says which project.
    const message = err instanceof Error ? err.message : String(err)

    record({
      step: 'plugin-pointer',
      outcome: 'warned',
      message: `Could not finish the Claude Code plugin step for ${root} (${message}). Run by hand: ${PLUGIN_INSTALL_COMMAND}`,
      level: 'warn',
    })
  }
}

const proxyEntry = (root: string, result: McpProxyReconcileResult): InitEntry[] => {
  const relative = path.relative(root, result.path)

  if (result.status !== 'ok' && result.status !== 'failed') {
    return [
      {
        step: 'mcp-proxies',
        outcome: 'warned',
        message: `  ${relative} could not be read as JSON — ik-mcp entries not synced`,
        level: 'warn',
      },
    ]
  }

  // The reconciler reports what it DECIDED per entry; `failed` means the write of those decisions
  // did not land, so echoing them as "updated" would describe a file that did not change.
  if (result.status === 'failed') {
    return [
      {
        step: 'mcp-proxies',
        outcome: 'warned',
        message: `  ${relative} could not be written — ik-mcp entries not synced`,
        level: 'warn',
      },
    ]
  }

  const entries: InitEntry[] = []

  for (const entry of result.entries) {
    if (entry.status === 'written') {
      entries.push({
        step: 'mcp-proxies',
        outcome: 'written',
        message: `  updated   ${relative} — ik-mcp "${entry.name}"`,
        level: 'info',
      })
    } else if (entry.status === 'conflict' || entry.status === 'stale') {
      entries.push({ step: 'mcp-proxies', outcome: 'warned', message: `  ${entry.message}`, level: 'warn' })
    }
  }

  return entries
}

/**
 * Derive one `.mcp.json` entry per `mcp.<name>` in the project config, in its OWN step.
 *
 * Kept out of {@link syncPluginPointer}'s `try` on purpose: that catch labels everything
 * `plugin-pointer`, and `syncPluginPointer` deliberately does not need an `infra-kit.json` at all —
 * so a bad `mcp` block, or no config, must cost this step alone and never the plugin install.
 */
// Absent or invalid config is a NO-OP that reports, never a reconcile: an empty derived set is
// indistinguishable from "every server was removed", so it must not reach the writer.
const syncMcpProxies = async (root: string | null): Promise<InitEntry[]> => {
  if (root === null) return []

  // No project config at all is the guidance gate's warning, already printed exactly once; this
  // step stays silent so `setup` in a non-infra-kit repo does not warn twice about one fact.
  if (!fs.existsSync(path.join(root, 'infra-kit.json'))) {
    return [
      {
        step: 'mcp-proxies',
        outcome: 'skipped',
        message: 'no infra-kit.json — no ik-mcp entries to derive',
        level: 'silent',
      },
    ]
  }

  let proxies: Awaited<ReturnType<typeof getInfraKitConfig>>['mcp']

  try {
    proxies = (await getInfraKitConfig()).mcp
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    return [
      {
        step: 'mcp-proxies',
        outcome: 'skipped',
        message: `  ik-mcp entries not synced — infra-kit.json could not be loaded (${message.split('\n')[0] ?? message})`,
        level: 'warn',
      },
    ]
  }

  if (!proxies || Object.keys(proxies).length === 0) return []

  return proxyEntry(root, reconcileMcpProxies({ projectRoot: root, proxies, write: true }))
}

const isBlockLine = (line: string): boolean => {
  return (
    line.startsWith('#') ||
    line.startsWith('alias ') ||
    line.startsWith('env-load') ||
    line.startsWith('env-clear') ||
    line.startsWith('env-status') ||
    line.startsWith('if ') ||
    line.startsWith('  export INFRA_KIT_SESSION') ||
    line.startsWith('export _INFRA_KIT_') ||
    line.startsWith(': ${_INFRA_KIT_') ||
    line.startsWith('fi') ||
    line.startsWith('zmodload ') ||
    line.startsWith('autoload ') ||
    line.startsWith('add-zsh-hook ') ||
    line.startsWith('_infra_kit_autoload')
  )
}

export const removeExistingBlock = (content: string): string => {
  // 1. Current markers
  const result = removeManagedBlock(content, MARKER_START, MARKER_END)

  if (result !== null) return result

  // 2. Legacy paired markers (# region / # endregion)
  for (const [start, end] of LEGACY_PAIRED) {
    const legacyResult = removeManagedBlock(content, start, end)

    if (legacyResult !== null) return legacyResult
  }

  // 3. Oldest format: single marker + heuristic scan
  const legacyIdx = content.indexOf(LEGACY_SINGLE)

  if (legacyIdx === -1) return content

  // eslint-disable-next-line sonarjs/super-linear-regex
  const before = content.slice(0, legacyIdx).replace(/\n+$/, '')
  const afterLines = content.slice(legacyIdx).split('\n')

  let i = 0

  while (i < afterLines.length && isBlockLine(afterLines[i]!)) {
    i++
  }

  const remaining = afterLines.slice(i).join('\n')

  return before + (remaining ? `\n${remaining}` : '')
}

/**
 * The inner shell-function lines (no markers). Composed into the full marked
 * block by {@link buildShellBlock} and fed to `upsertManagedBlock` by `initCore`.
 */
export const buildShellBody = (): string => {
  const runCmd = 'pnpm exec infra-kit'

  return [
    'zmodload zsh/stat 2>/dev/null',
    'zmodload zsh/datetime 2>/dev/null',
    'zmodload zsh/sched 2>/dev/null',
    // eslint-disable-next-line no-template-curly-in-string
    'if [[ -z "${INFRA_KIT_SESSION}" ]]; then',
    '  export INFRA_KIT_SESSION=$(head -c 4 /dev/urandom | xxd -p)',
    'fi',
    // eslint-disable-next-line no-template-curly-in-string
    ': ${_INFRA_KIT_LAST_LOAD_MTIME:=0}',
    // eslint-disable-next-line no-template-curly-in-string
    ': ${_INFRA_KIT_LAST_CLEAR_MTIME:=0}',
    // eslint-disable-next-line no-template-curly-in-string
    ': ${_INFRA_KIT_SHELL_STARTED:=${EPOCHSECONDS:-0}}',
    // Warm-cache source TTL (seconds); MUST equal DEFAULT_WARM_TTL_SECONDS (node
    // eviction) — both 2h. A warm file older than this is not sourced at startup.
    // eslint-disable-next-line no-template-curly-in-string
    ': ${_INFRA_KIT_WARM_TTL:=7200}',
    'export _INFRA_KIT_LAST_LOAD_MTIME _INFRA_KIT_LAST_CLEAR_MTIME _INFRA_KIT_SHELL_STARTED _INFRA_KIT_WARM_TTL',
    `env-load() { local f m; f=$(${runCmd} env-load "$@") || return; m=$(zstat +mtime -- "$f" 2>/dev/null || echo 0); _INFRA_KIT_LAST_LOAD_MTIME=$m; source "$f"; ${runCmd} env-status; }`,
    `env-clear() { local f m; f=$(${runCmd} env-clear "$@") || return; m=$(zstat +mtime -- "$f" 2>/dev/null || echo 0); _INFRA_KIT_LAST_CLEAR_MTIME=$m; source "$f"; ${runCmd} env-status; }`,
    `env-status() { ${runCmd} env-status; }`,
    // No `alias ik=…` here: a global install provides real `infra-kit` and `ik` bins, and an alias
    // would SHADOW the global `ik`, forcing the project-local `pnpm exec` even when a global CLI exists.
    // (`isBlockLine` still lists `alias ` so re-running `initCore` strips the stale alias from old configs.)
    // Print an async notice without corrupting an already-drawn prompt. The
    // startup poll fires via `sched` at an IDLE prompt (ZLE active) which does
    // NOT redraw the prompt, so a bare `print` lands appended to the visible
    // prompt line and looks like un-removable typed input. When ZLE is active we
    // erase the current line (CR + clear-to-EOL), print the message on its own
    // line, then `zle reset-prompt` to redraw the prompt below it. In precmd /
    // shell-startup (ZLE inactive) `zle` is false and this is a plain stderr
    // print above the about-to-be-drawn prompt — unchanged behavior.
    '_infra_kit_notify() {',
    // When ZLE is active, erase the current prompt line first and redraw after;
    // both are no-ops when ZLE is inactive so this stays a plain stderr print.
    "  zle && print -u2 -n $'\\r\\e[K'",
    '  print -u2 -- "$1"',
    '  zle && zle reset-prompt',
    '}',
    '_infra_kit_autoload() {',
    '  [[ -z "$INFRA_KIT_SESSION" ]] && return',
    // eslint-disable-next-line no-template-curly-in-string
    '  local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit"',
    '  local dir="$cache_root/$INFRA_KIT_SESSION"',
    '  local load_file="$dir/env-load.sh"',
    '  local clear_file="$dir/env-clear.sh"',
    '  local load_mtime=0 clear_mtime=0',
    '  [[ -f "$load_file" ]] && load_mtime=$(zstat +mtime -- "$load_file" 2>/dev/null || echo 0)',
    '  [[ -f "$clear_file" ]] && clear_mtime=$(zstat +mtime -- "$clear_file" 2>/dev/null || echo 0)',
    '  if (( load_mtime > _INFRA_KIT_LAST_LOAD_MTIME && load_mtime >= _INFRA_KIT_SHELL_STARTED && load_mtime >= clear_mtime )); then',
    '    source "$load_file"',
    '    _INFRA_KIT_LAST_LOAD_MTIME=$load_mtime',
    // eslint-disable-next-line no-template-curly-in-string
    '    _infra_kit_notify "infra-kit: auto-loaded vars for ${INFRA_KIT_ENV_CONFIG:-?}"',
    '  fi',
    '  if (( clear_mtime > _INFRA_KIT_LAST_CLEAR_MTIME && clear_mtime >= _INFRA_KIT_SHELL_STARTED && clear_mtime > load_mtime )); then',
    '    source "$clear_file"',
    '    _INFRA_KIT_LAST_CLEAR_MTIME=$clear_mtime',
    '    _infra_kit_notify "infra-kit: auto-cleared env"',
    '  fi',
    '}',
    'autoload -Uz add-zsh-hook',
    'if (( _INFRA_KIT_SHELL_STARTED > 0 )); then',
    '  add-zsh-hook precmd _infra_kit_autoload',
    'fi',
    // Non-blocking startup poll: the shell-startup spawn (below) writes env-load.sh
    // asynchronously (node + Doppler fetch, ~0.5-2s), so the FIRST precmd — which
    // fires before the first prompt — runs before the file lands and sources nothing;
    // without this the vars only appear after the user's first command. This one-shot
    // re-arming poll re-runs the precmd sourcer once per second, at the idle prompt
    // with NO user command, until it sources the freshly written file (its mtime is
    // >= _INFRA_KIT_SHELL_STARTED so the existing gate accepts it) OR the startup
    // window closes. _infra_kit_autoload sets _INFRA_KIT_LAST_LOAD_MTIME on a
    // successful source, which lifts it to >= _INFRA_KIT_SHELL_STARTED and stops the
    // re-arm. Bounded to WINDOW seconds so an unconfigured project / down Doppler
    // that never writes a file only costs a handful of no-op ticks, then falls back
    // to the precmd hook. Sources the same freshly written file as precmd, so there
    // is no stale/last-known-good secrets window.
    '_INFRA_KIT_AUTOLOAD_WINDOW=6',
    'export _INFRA_KIT_AUTOLOAD_WINDOW',
    '_infra_kit_poll_autoload() {',
    '  _infra_kit_autoload',
    // eslint-disable-next-line no-template-curly-in-string
    '  if (( _INFRA_KIT_LAST_LOAD_MTIME < _INFRA_KIT_SHELL_STARTED )) && (( ${EPOCHSECONDS:-0} - _INFRA_KIT_SHELL_STARTED < _INFRA_KIT_AUTOLOAD_WINDOW )); then',
    '    (( $+builtins[sched] )) && sched +1 _infra_kit_poll_autoload',
    '  fi',
    '}',
    // Warm cache: source the project-scoped last-known-good env-load.sh INSTANTLY at
    // startup (pure zsh, no node/Doppler) so vars are present at prompt-0, before the
    // backgrounded refresh lands. `key` is sha256 of the canonical project dir passed
    // in by the caller — byte-identical to node's warmCacheKey (printf %s | shasum,
    // full 64-hex). Skips when: no sha tool (degrade to poll), no warm file, a project
    // clear-marker is at least as new (clear wins ties), or the file is past TTL
    // (bounds a rotated secret served at prompt-0). Deliberately does NOT set
    // _INFRA_KIT_LAST_LOAD_MTIME (leaves it 0) so the poll/precmd still source the
    // fresh SESSION file (different path, newer mtime) and upgrade warm->fresh.
    '_infra_kit_warm_source() {',
    '  local canon="$1" key',
    '  if (( $+commands[shasum] )); then',
    '    key=$(printf %s "$canon" | shasum -a 256 | cut -c1-64)',
    '  elif (( $+commands[sha256sum] )); then',
    '    key=$(printf %s "$canon" | sha256sum | cut -c1-64)',
    '  else',
    '    return',
    '  fi',
    // eslint-disable-next-line no-template-curly-in-string
    '  local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit"',
    '  local warm="$cache_root/projects/$key/env-load.sh"',
    '  local wclear="$cache_root/projects/$key/env-clear.sh"',
    '  [[ -f "$warm" ]] || return',
    '  local wm=0 cm=0',
    '  wm=$(zstat +mtime -- "$warm" 2>/dev/null || echo 0)',
    '  [[ -f "$wclear" ]] && cm=$(zstat +mtime -- "$wclear" 2>/dev/null || echo 0)',
    '  (( cm >= wm )) && return',
    // eslint-disable-next-line no-template-curly-in-string
    '  (( ${EPOCHSECONDS:-0} - wm >= _INFRA_KIT_WARM_TTL )) && return',
    '  source "$warm"',
    // eslint-disable-next-line no-template-curly-in-string
    '  _infra_kit_notify "infra-kit: loaded cached vars for ${INFRA_KIT_ENV_CONFIG:-?} (refreshing…)"',
    '}',
    // One-shot env auto-load when a NEW shell opens inside an infra-kit project
    // or worktree (config: envAutoLoad.trigger "shell-startup"). Cheap pure-zsh
    // project gate (walk up for infra-kit.json) avoids spawning node in unrelated
    // shells; the spawn is skipped only when the already-loaded env belongs to THIS
    // project root (INFRA_KIT_ENV_PROJECT_ROOT), so cd'ing into a DIFFERENT project
    // re-loads instead of silently keeping the previous project's secrets. The spawn
    // is DETACHED+backgrounded ( ... & ) so it never blocks the prompt; it only
    // WRITES env-load.sh. The startup poll armed right after (and the precmd hook as
    // a later-prompt fallback) sources the file once it lands. Trade-off: the gate
    // can't read the merged JSON config, so a fresh shell in a project WITHOUT
    // envAutoLoad still spawns one background process that resolves config, finds
    // nothing, and exits.
    '_infra_kit_startup_autoload() {',
    '  [[ -z "$INFRA_KIT_SESSION" ]] && return',
    '  local dir="$PWD" prev=""',
    '  while [[ -n "$dir" && "$dir" != "$prev" ]]; do',
    '    if [[ -f "$dir/infra-kit.json" ]]; then',
    '      [[ -n "$INFRA_KIT_ENV_CONFIG" && "$dir" == "$INFRA_KIT_ENV_PROJECT_ROOT" ]] && return',
    // canon = realpath of the project dir; the SAME string node hashes for the warm
    // key (passed via --project-dir), so the two keys are byte-identical.
    // eslint-disable-next-line no-template-curly-in-string
    '      local canon="${dir:A}"',
    '      _infra_kit_warm_source "$canon"',
    `      ( ${runCmd} env-autoload --project-dir "$canon" & ) >/dev/null 2>&1`,
    '      (( $+builtins[sched] )) && sched +1 _infra_kit_poll_autoload',
    '      return',
    '    fi',
    '    prev="$dir"',
    // eslint-disable-next-line no-template-curly-in-string
    '    dir="${dir:h}"',
    '  done',
    '}',
    'if (( _INFRA_KIT_SHELL_STARTED > 0 )); then',
    '  _infra_kit_startup_autoload',
    'fi',
  ].join('\n')
}

/**
 * The full marker-delimited shell block (`MARKER_START … MARKER_END`). Kept as
 * a single composed string so `doctor`'s exact-match freshness check stays valid.
 */
export const buildShellBlock = (): string => {
  return `${MARKER_START}\n${buildShellBody()}\n${MARKER_END}`
}

/**
 * The inner lines of the `~/.zshenv` block (no markers): source this terminal's session `env-load.sh`
 * — or, once cleared, its `env-clear.sh` — into every zsh that inherited `INFRA_KIT_SESSION`, so a
 * long-lived process spawned before the load (Claude Code's Bash tool, a tmux server, an editor)
 * still sees it. Every line is load-bearing; see docs/session-zshenv-plan.md §1.2 for why each one.
 */
export const buildZshenvBody = (): string => {
  return [
    "# Inherit this terminal's infra-kit session env into every zsh it spawns, interactive or not.",
    '# A fresh terminal has no session yet (it is minted in .zshrc, after this file) and skips.',
    '# Only the canonical 8-hex id .zshrc mints is honoured. Load wins a tie with clear, as the',
    '# .zshrc precmd gate does. Prints nothing of its own.',
    // eslint-disable-next-line no-template-curly-in-string
    'if [[ -n "${INFRA_KIT_SESSION:-}" ]]; then',
    '  () {',
    '    emulate -L zsh -o extendedglob',
    // eslint-disable-next-line no-template-curly-in-string
    '    [[ "${INFRA_KIT_SESSION:-}" == [0-9a-f](#c8) ]] || return',
    // eslint-disable-next-line no-template-curly-in-string
    '    local _ik_dir="${XDG_CACHE_HOME:-$HOME/.cache}/infra-kit/$INFRA_KIT_SESSION"',
    '    local _ik_load="$_ik_dir/env-load.sh" _ik_clear="$_ik_dir/env-clear.sh"',
    '    if [[ -r "$_ik_load" && ! "$_ik_clear" -nt "$_ik_load" ]]; then',
    '      source "$_ik_load"',
    '    elif [[ -r "$_ik_clear" ]]; then',
    '      source "$_ik_clear"',
    '    fi',
    '  }',
    'fi',
  ].join('\n')
}

/**
 * The full marker-delimited `.zshenv` block. Same shape as {@link buildShellBlock} so `doctor`'s
 * exact-match freshness check works on both files.
 */
export const buildZshenvBlock = (): string => {
  return `${MARKER_START}\n${buildZshenvBody()}\n${MARKER_END}`
}
