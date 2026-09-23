import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import type { GuidanceWrite } from 'src/lib/agent-guidance'
import { seedCreatedMessage, seedUserProjectConfig } from 'src/lib/config-bootstrap'
import { CONFIG_STUB, buildUserGlobalExample, buildVendorExample } from 'src/lib/config-templates'
import { getCacheRoot } from 'src/lib/constants'
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
  migrateConfigShapes,
  migrateFactoryConfigToJson,
  migrateLegacyConfig,
  migrateUserGlobalConfigFilename,
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
 * `written` changed something; `unchanged` ran and changed nothing of its own (the migrators print
 * their own conversion lines, so their step reports `unchanged`); `skipped` did not run; `manual` was
 * not run by the CLI, and the message carries the command a human runs instead; `warned` is a
 * best-effort failure that did not stop the run; `failed` is a step that threw and ended the init half.
 *
 * `manual` is a member here rather than a label a caller derives, so the `--json` payload names it:
 * an agent reading `skipped` could not tell "nothing to do" from "a human has to run this".
 */
export type InitOutcome = 'failed' | 'manual' | 'skipped' | 'unchanged' | 'warned' | 'written'

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
 * The tag exists for `setup`, the only caller: it catches this, records the step as `failed`, and goes
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

/**
 * The four migrations announce their own conversions and the cache reaper is silent, so this step
 * has nothing of its own to print.
 */
const MIGRATIONS_CHECKED: InitEntry = {
  step: 'migrations',
  outcome: 'unchanged',
  message:
    'Config migrations checked (legacy yml layers, user-global filename, ide structure, factory config, retired project cache)',
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
    removeRetiredWarmCacheRoot()
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
 * `setup` does not stream entries (its end table carries them), so the only callers are the init
 * suites, which assert each step's line through the logger. It stays here rather than in a test helper
 * so those suites keep reading the production mapping of `level` to stream.
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

/**
 * `<cacheRoot>/projects/` held per-project warm copies of `env-load.sh` — secrets on disk — whose only
 * sweeper was the retired env auto-load. Nothing reads the dir any more, so it is removed outright.
 */
export const removeRetiredWarmCacheRoot = (): void => {
  fs.rmSync(path.join(getCacheRoot(), 'projects'), { recursive: true, force: true })
}

/**
 * Three file-existence one-shots, then the shared shape pipeline — in the one order that works.
 */
const runConfigMigrations = async (): Promise<void> => {
  // Convert any legacy infra-kit.yml config layers to JSON before seeding, so a
  // migrated infra-kit.json is not re-seeded as an empty stub.
  await migrateLegacyConfig()

  // Rename a legacy user-global config.json → infra-kit.json (single canonical
  // filename). MUST run before seeding: otherwise the seeder checks the new name,
  // doesn't find it, and writes an empty stub that shadows the user's real config.
  await migrateUserGlobalConfigFilename()

  // Strip every retired shape from the JSON layers — the same registry the loader applies on
  // read, run here across all layers at once. AFTER the filename rename: outside a project it
  // addresses ~/.infra-kit/infra-kit.json by that fixed name.
  await migrateConfigShapes()

  // Convert a legacy machine-local factory config from executable TS
  // (~/.infra-kit/vendor.config.ts) to static JSON (~/.infra-kit/vendor.json).
  // Independent of the infra-kit.json layers; grouped with the other migrations.
  await migrateFactoryConfigToJson()
}

/**
 * The shell integration is zsh-only (it lives in ~/.zshrc and ~/.zshenv, and the zshenv block leans on
 * zsh globbing), so a non-zsh login shell is warned about non-fatally rather than left with a silent
 * no-op block.
 */
const shellEntries = (): InitEntry[] => {
  const shell = process.env.SHELL ?? ''
  const entries: InitEntry[] = []

  if (!shell.includes('zsh')) {
    entries.push({
      step: 'shell',
      outcome: 'warned',
      message: `Your login shell ($SHELL=${shell || 'unset'}) is not zsh. The infra-kit shell integration (env-load/env-clear) is zsh-only and won't activate in bash/fish.`,
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
  if (process.env.INFRA_KIT_NO_SEED) return [projectConfigSkip('skipped', 'INFRA_KIT_NO_SEED is set')]

  try {
    const paths = await getInfraKitConfigPaths()

    // The same D2 gate the preAction seed applies — re-evaluated now that the migrations have run.
    if (!fs.existsSync(paths.main)) return [projectConfigSkip('skipped', `no project config at ${paths.main}`)]

    const result = await seedUserProjectConfig(paths)

    if (!result.createdConfig) return [projectConfigSkip('unchanged', 'the user-project config was already present')]

    return [{ step: 'project-config', outcome: 'written', message: seedCreatedMessage(result), level: 'info' }]
  } catch (err) {
    // Kept as a raw logger call rather than routed through an entry: the `err` OBJECT is the whole point
    // of this line, and an entry carries a message string. The entry beside it reports the outcome.
    logger.debug({ err, msg: 'Skipped seeding the user-project config (init).' })

    return [projectConfigSkip('warned', err instanceof Error ? err.message : String(err))]
  }
}

/**
 * Every reason the layer-3 reseed does nothing is silent on the CLI, exactly as it has always been —
 * but the reasons differ in outcome: a gate that declined did not run, a config already present ran
 * and found nothing to do, and a throw is a best-effort failure.
 */
const projectConfigSkip = (outcome: 'skipped' | 'unchanged' | 'warned', why: string): InitEntry => {
  return {
    step: 'project-config',
    outcome,
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
      message: `  ${relative} still registers the infra-kit MCP server under "${key}" — the plugin no longer serves one, so this entry only spawns a failed server row. Delete the "${key}" entry from ${relative} by hand in a PR, keeping its siblings`,
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
    return { step: 'plugin-pointer', outcome: 'manual', message: command, level: 'info' }
  })
}

/**
 * The withheld update, as a WARN line naming the version the reader is behind, then — when the command
 * that closes the gap is known — that command as its own `manual` entry, the same shape as
 * {@link manualInstallEntries}: a note a human copies has to be the bare argv, not a sentence around it.
 *
 * The installer reports `skipped-cli-stale` only when the `cliIsStale` thunk it was handed returned
 * true, and that thunk reads `staleness.stale`; the non-stale arm exists for the type, not for a path.
 */
const cliStaleEntries = (staleness: CliStaleness): InitEntry[] => {
  const behind = staleness.stale
    ? `CLI ${packageJson.version} is behind ${staleness.latestVersion}, update it first with the command below`
    : `CLI ${packageJson.version} is behind the published version, update it first`
  const prose: InitEntry = {
    step: 'plugin-pointer',
    outcome: 'warned',
    message: `Claude Code plugin not updated — ${behind}. The plugin follows on the next update check after that.`,
    level: 'warn',
  }

  if (!staleness.stale) return [prose]

  return [
    prose,
    { step: 'plugin-pointer', outcome: 'manual', message: formatUpdateCommand(staleness.updateCommand), level: 'info' },
  ]
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
  if (outcome.status === 'skipped-cli-stale') return cliStaleEntries(staleness)

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
        outcome: 'warned',
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
    line.startsWith('fi')
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
    // eslint-disable-next-line no-template-curly-in-string
    'if [[ -z "${INFRA_KIT_SESSION}" ]]; then',
    '  export INFRA_KIT_SESSION=$(head -c 4 /dev/urandom | xxd -p)',
    'fi',
    `env-load() { local f; f=$(${runCmd} env-load "$@") || return; source "$f"; ${runCmd} env-status; }`,
    `env-clear() { local f; f=$(${runCmd} env-clear "$@") || return; source "$f"; ${runCmd} env-status; }`,
    `env-status() { ${runCmd} env-status; }`,
    // No `alias ik=…` here: a global install provides real `infra-kit` and `ik` bins, and an alias
    // would SHADOW the global `ik`, forcing the project-local `pnpm exec` even when a global CLI exists.
    // (`isBlockLine` still lists `alias ` so re-running `initCore` strips the stale alias from old configs.)
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
    '# Only the canonical 8-hex id .zshrc mints is honoured. Load wins a tie with clear.',
    '# Prints nothing of its own.',
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
