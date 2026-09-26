import type { z } from 'zod'

import { auditMcpTool } from 'src/commands/audit'
import { configGetMcpTool } from 'src/commands/config-get'
import { devStatusMcpTool } from 'src/commands/dev-status'
import { doctorMcpTool } from 'src/commands/doctor'
import { e2eMcpTool } from 'src/commands/e2e'
import { envClearMcpTool } from 'src/commands/env-clear'
import { envListMcpTool } from 'src/commands/env-list'
import { envLoadMcpTool } from 'src/commands/env-load'
import { envStatusMcpTool } from 'src/commands/env-status'
import { envTokenListMcpTool } from 'src/commands/env-token-list'
import { ghMergeDevMcpTool } from 'src/commands/gh-merge-dev'
import { ghReleaseDeliverMcpTool } from 'src/commands/gh-release-deliver'
import { ghReleaseDeployAllMcpTool } from 'src/commands/gh-release-deploy-all'
import { ghReleaseDeploySelectedMcpTool } from 'src/commands/gh-release-deploy-selected'
import { ghReleaseListMcpTool } from 'src/commands/gh-release-list'
import { localDeployAllMcpTool, localDeploySelectedMcpTool } from 'src/commands/local-deploy'
import { releaseCreateMcpTool } from 'src/commands/release-create'
import { releaseEditMcpTool } from 'src/commands/release-edit'
import { releaseRemoveMcpTool } from 'src/commands/release-remove'
import { setupMcpTool } from 'src/commands/setup'
import { vendorCheckMcpTool } from 'src/commands/vendor-check'
import { versionMcpTool } from 'src/commands/version'
import { worktreesAddMcpTool } from 'src/commands/worktrees-add'
import { worktreesListMcpTool } from 'src/commands/worktrees-list'
import { worktreesRemoveMcpTool } from 'src/commands/worktrees-remove'
import { worktreesSyncMcpTool } from 'src/commands/worktrees-sync'
import type { ArgumentFormProvider, ToolsExecutionResult } from 'src/types'

/**
 * Catalog-facing shape of a command's tool definition. The concrete `*McpTool` definitions
 * are generic over their Zod input/output shapes (and invariant), so they cannot
 * share one precise `McpTool<...>` element type in an array. This widened, non-
 * generic view exposes exactly what the catalog's readers need and every concrete tool
 * assigns to it.
 */
export interface CatalogMcpTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  outputSchema: z.ZodRawShape
  /**
   * The catalog's own "this mutation is gated by `confirmOrExit`" declaration — the only
   * machine-readable link between {@link CommandCatalogEntry.mutating} and `confirmOrExit`. Widened,
   * non-generic mirror of {@link McpTool.requiresHumanConfirm} so the catalog tests can read it without
   * reaching into the concrete generic tool type.
   */
  requiresHumanConfirm?: boolean
  /**
   * Optional per-tool argument-form seam consumed by `refuse-missing-arguments.ts`, which builds the
   * refusal's `choices` from it. Widened, non-generic mirror of {@link McpTool.formProvider} for the
   * same reason `requiresHumanConfirm` is mirrored above.
   *
   * {@link ArgumentFormProvider} is itself non-generic and lives in `src/types`, which this module
   * already imports from — so mirroring it costs no new dependency.
   */
  formProvider?: ArgumentFormProvider
  // Heterogeneous tool params; loose `any` keeps the array element type assignable from every tool.
  handler: (params: any) => Promise<ToolsExecutionResult>
}

/**
 * Single source of truth for the CLI command surface. It consolidates what used
 * to live in hand-maintained places (the retired server's `tools[]` array and the
 * three no-arg-menu name arrays) into one list, so they can no longer drift.
 *
 * It does NOT replace Commander's `.command().option()` wiring in entry/cli.ts —
 * that stays the source of truth for argument parsing. This catalog only carries
 * cross-surface metadata: the canonical names, which menu group a command shows
 * in, the tool definition whose schema shapes an agent's `argument_required`
 * refusal, and the `mutating` flag the confirm gate keys off.
 */

/**
 * The menu groups, in display order — the SINGLE source of both membership and presentation. `cli.ts`
 * renders the palette by mapping over this list, so adding, renaming, or reordering a group is a
 * one-line edit here and nowhere else. (The group list used to be restated three times in `cli.ts`, and
 * the labels a fourth time in the Inquirer separators.)
 *
 * One group per CLI noun, ordered by how often it is reached for. `Develop` leads because `dev` is the
 * daily driver. `Environment` means the Doppler env commands and nothing else — it used to be a
 * 13-entry drawer holding config, vendor, and setup commands too, which made its name a lie.
 */
export const MENU_GROUPS = [
  { key: 'develop', label: 'Develop' },
  { key: 'release', label: 'Release Management' },
  { key: 'worktrees', label: 'Worktrees' },
  { key: 'environment', label: 'Environment' },
  { key: 'configuration', label: 'Configuration' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'setup', label: 'Setup & Diagnostics' },
] as const

/** Top-level menu group for the no-arg interactive picker (null = not shown). */
export type MenuGroup = (typeof MENU_GROUPS)[number]['key']

export interface CommandCatalogEntry {
  /**
   * Stable flat id for the command (`release-create`), and its tool definition's `name` — a tool name
   * cannot contain a space, so the grouped path cannot serve as one.
   *
   * NOT a CLI surface: the CLI registers only the grouped form ({@link groupPath}). Flat Commander
   * commands were removed once every menu surface learned to address a command by its group path.
   */
  cliName: string
  /** Menu group, or null for subcommands not shown at the top level. */
  menuGroup: MenuGroup | null
  /**
   * The co-located tool definition (input/output schema, confirm and form metadata), or null for the
   * commands that never had one (setup/config/vendor group, env-token-set/remove).
   */
  mcpTool: CatalogMcpTool | null
  /**
   * Historical: whether the command was listed on the retired MCP server. NOT "agent-reachable" — every
   * command is one `Bash(infra-kit …)` away; unread at runtime.
   */
  mcpExposed: boolean
  /**
   * Whether running this command writes git/remote/consumer-repo/Doppler-env/fs-outside-cache state.
   * Drives the destructive-op gate: a mutating command must set `requiresHumanConfirm` or `humanOnly`, or
   * sit in {@link LOW_RISK_MUTATING_ALLOWLIST}.
   */
  mutating: boolean
  /**
   * Canonical Commander argv for this command (grouped form, e.g. `['vendor','check']`) — the ONLY form
   * the CLI registers. Every menu surface renders `groupPath.join(' ')` and spawns/parses
   * `infra-kit <...groupPath>`, so what the palette shows is exactly what it runs and what the user can
   * retype.
   */
  groupPath: string[]
  /**
   * The command hands the terminal to a full-screen child (an `$EDITOR`) that enters the alternate
   * screen and restores it itself. The session never enters it for them — but a child killed before it
   * restores the primary buffer would leave every later frame drawn into an abandoned buffer, so the
   * session's post-child hygiene reset leaves the alternate screen defensively. Only `config-edit`.
   */
  entersAltScreen?: boolean
  /**
   * Running this from inside the session cannot mutate the parent shell's env (a child can't). The
   * transcript entry appends a notice that the change applies only after the session exits. `env-load`
   * / `env-clear`.
   */
  sessionEnvNotice?: boolean
  /**
   * A foreground process that runs until the user stops it, rather than doing a unit of work and
   * exiting. Only `dev`. It breaks BOTH of the session shell's assumptions about a child, so the two
   * consequences are deliberately carried by ONE flag — they must never be set apart:
   *
   * 1. **It produces no verdict.** Its Commander action RESOLVES seconds after boot (the process stays
   *    alive on fastify/chokidar handles, not on a pending promise), so `postAction` would write a
   *    session report while the server is merely *starting*. Report-presence means "the command produced
   *    a verdict" (see `session/report.ts`), so the report is suppressed for it entirely.
   * 2. **It exits `128 + signo`, not 0.** It installs its own SIGINT handler and exits 130 on a Ctrl-C
   *    — deliberately, so a supervisor sees an honest signal death. Without this flag the session would
   *    read that as a failure and stamp every normal dev exit `✗ failed`.
   */
  longRunning?: boolean
  /**
   * Refused under agent mode even with `--yes`: a human types it in their own shell or it does not run.
   * Satisfies the destructive-op gate in place of `requiresHumanConfirm`, because a refusal is stricter
   * than any confirm an agent could answer.
   */
  humanOnly?: true
}

/**
 * Authored in no-arg-menu display order so the interactive picker derives
 * directly from this list (see entry/cli.ts). Nothing else reads the order:
 * every other consumer addresses an entry by `cliName` or `groupPath`.
 */
export const commandCatalog: CommandCatalogEntry[] = [
  // --- Develop (menu group) ---
  // The local dev server, and the reason most people open this menu at all — so it leads.
  //
  // It is a long-running foreground child, which the one-shot Inquirer menu could not host: that menu
  // ran the pick IN-PROCESS, so a dev server would have blocked the menu process forever. The session
  // shell spawns every pick as a separate child on the primary screen and swallows SIGINT while one
  // runs, so Ctrl-C stops only the dev server and the palette comes back. See `longRunning` for the two
  // session assumptions it still breaks (no verdict; exits 128+signo).
  //
  // Spawning the BARE `['dev']` path is deliberate: `shouldRunWizard` fires on exactly bare + TTY +
  // non-json, so a menu pick lands in the interactive wizard — the wizard IS the flag picker.
  //
  // No tool definition: it never returns a result, so it cannot fit the request/response tool contract.
  {
    cliName: 'dev',
    menuGroup: 'develop',
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['dev'],
    longRunning: true,
  },
  // Read-only companion to `dev`: reports what `infra-kit dev` currently has running by reading the
  // on-disk dev-context fragments (never starts a server). Top-level (`infra-kit dev-status`) per the
  // house rule — new commands go top-level with related names, not nested under a group — but carries
  // menuGroup 'develop' so it renders beside `dev` in the palette (same shape as env-status).
  {
    cliName: 'dev-status',
    menuGroup: 'develop',
    mcpTool: devStatusMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['dev-status'],
  },
  // Tests what `dev` serves, or the deployed app when nothing is served. `requiresHumanConfirm` covers the
  // cloud run only — a local run touches nothing but this machine, so it runs without a preview.
  {
    cliName: 'e2e',
    menuGroup: 'develop',
    mcpTool: e2eMcpTool,
    mcpExposed: false,
    mutating: true,
    groupPath: ['e2e'],
  },

  // --- Release Management (menu group) ---
  {
    cliName: 'merge-dev',
    menuGroup: 'release',
    mcpTool: ghMergeDevMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'merge-dev'],
  },
  {
    cliName: 'release-list',
    menuGroup: 'release',
    mcpTool: ghReleaseListMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['release', 'list'],
  },
  {
    cliName: 'release-create',
    menuGroup: 'release',
    mcpTool: releaseCreateMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'create'],
  },
  {
    cliName: 'release-edit',
    menuGroup: 'release',
    mcpTool: releaseEditMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'edit'],
  },
  {
    cliName: 'release-deploy-all',
    menuGroup: 'release',
    mcpTool: ghReleaseDeployAllMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'deploy-all'],
  },
  {
    cliName: 'release-deploy-selected',
    menuGroup: 'release',
    mcpTool: ghReleaseDeploySelectedMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'deploy-selected'],
  },
  // release-deliver does prod delivery + admin-merge — genuinely irreversible,
  // so it is human-only: refused under `--agent`, `--yes` included.
  {
    cliName: 'release-deliver',
    menuGroup: 'release',
    mcpTool: ghReleaseDeliverMcpTool,
    mcpExposed: false,
    mutating: true,
    humanOnly: true,
    groupPath: ['release', 'deliver'],
  },
  // Gated, not refused, unlike its neighbour `release-deliver`. What an agent may run is governed by
  // the allowlist-or-gate rule, not by whether the verb sounds destructive: `requiresHumanConfirm` puts it behind the
  // two-phase gate, `version` is optional so the human picks from a form, `skipJira` is refused,
  // `moveIssuesTo` is accepted and shown in the gate, and the one irreversible step (the Jira fix
  // version) runs behind that gate. The asymmetry that would otherwise exist is the argument for
  // gating rather than refusing it: an agent can create a release, so it must be able to clean one up.
  {
    cliName: 'release-remove',
    menuGroup: 'release',
    mcpTool: releaseRemoveMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'remove'],
  },
  // The CLI commands behind these two are DEPRECATED aliases of `release deploy-* --from local`,
  // so `menuGroup: null` keeps them out of the palette while they still resolve for anyone who types
  // them. The tools are deliberately NOT folded into the release pair: `local-deploy-selected`
  // requires `service` with `.min(1)` — a merged tool would have to relax that, and an agent omitting
  // it would deploy everything. Agent-reachable while human-unbrowsable is the intended end state here.
  {
    cliName: 'local-deploy-all',
    menuGroup: null,
    mcpTool: localDeployAllMcpTool,
    mcpExposed: true,
    // Writes to real cloud infrastructure. Both carry `requiresHumanConfirm`, so an agent gets the
    // two-phase gate — unlike the release-deploy-* pair these leave no CI run to inspect afterwards.
    mutating: true,
    groupPath: ['local', 'deploy-all'],
  },
  {
    cliName: 'local-deploy-selected',
    menuGroup: null,
    mcpTool: localDeploySelectedMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['local', 'deploy-selected'],
  },

  // --- Worktrees (menu group) ---
  {
    cliName: 'worktrees-add',
    menuGroup: 'worktrees',
    mcpTool: worktreesAddMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['worktrees', 'add'],
  },
  {
    cliName: 'worktrees-list',
    menuGroup: 'worktrees',
    mcpTool: worktreesListMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['worktrees', 'list'],
  },
  // worktrees-remove runs `git worktree remove` (no --force) on the named leaf worktrees. It is NOT
  // irreversible in the way release-deliver is: the release branches/commits survive, the
  // worktrees scaffold survives, and worktrees-add recreates a removed worktree. git also
  // refuses to remove a worktree with modified-tracked or untracked files. The residual risk —
  // deletion of gitignored local state (a hydrated `.env` of Doppler secrets, node_modules/dist) — is
  // contained by the command's own invariants rather than by withholding it: under `--agent` it rejects
  // all=true (no one-shot wipe) and errors on any unmatched target before removing anything. So it is
  // gated, not refused, unlike the genuinely-irreversible release-deliver. After a refused removal it sweeps
  // ONLY a leftover git has already unregistered and that holds nothing but `.omc/{state,sessions}`
  // and `.DS_Store` (a post-exit hook re-creating tool state mid-deletion); everything else is
  // reported in failedWorktrees with isError.
  {
    cliName: 'worktrees-remove',
    menuGroup: 'worktrees',
    mcpTool: worktreesRemoveMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['worktrees', 'remove'],
  },
  {
    cliName: 'worktrees-sync',
    menuGroup: 'worktrees',
    mcpTool: worktreesSyncMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['worktrees', 'sync'],
  },

  // --- Environment (menu group): the Doppler env commands, and ONLY those ---
  // Every menu-eligible entry must be a Commander LEAF (an action, no subcommands) so the session
  // shell's report discriminator holds. The bare `vendor`/`config` GROUPS are menuGroup:null — a bare
  // group prints help and exits non-zero, which the shell would misreport. Their useful leaves
  // (vendor-check/diff/config, config-path/edit) are surfaced in the Vendor/Configuration groups below,
  // each with a hidden flat Commander alias (see src/lib/program/program.ts) so the palette can
  // introspect + single-token dispatch.
  {
    cliName: 'env-status',
    menuGroup: 'environment',
    mcpTool: envStatusMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['env-status'],
  },
  {
    cliName: 'env-list',
    menuGroup: 'environment',
    mcpTool: envListMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['env-list'],
  },
  {
    cliName: 'env-load',
    menuGroup: 'environment',
    mcpTool: envLoadMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['env-load'],
    sessionEnvNotice: true,
  },
  {
    cliName: 'env-clear',
    menuGroup: 'environment',
    mcpTool: envClearMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['env-clear'],
    sessionEnvNotice: true,
  },
  // The only env-token command that is agent-callable. It READS, and only ever emits redacted values.
  {
    cliName: 'env-token-list',
    menuGroup: 'environment',
    mcpTool: envTokenListMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['env-token-list'],
  },

  // --- Configuration (menu group) ---
  // Read-only merged-config introspection. Top-level (`infra-kit config-get`) per the house rule — new
  // commands go top-level with related names — but menuGroup 'configuration' renders it beside
  // `config path`/`config edit`. Exposed to agents (mutating:false); `config edit` stays CLI-only for writes.
  {
    cliName: 'config-get',
    menuGroup: 'configuration',
    mcpTool: configGetMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['config-get'],
  },
  {
    cliName: 'config-path',
    menuGroup: 'configuration',
    mcpTool: null,
    mcpExposed: false,
    mutating: false,
    groupPath: ['config', 'path'],
  },
  {
    cliName: 'config-edit',
    menuGroup: 'configuration',
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['config', 'edit'],
    entersAltScreen: true,
  },

  // --- Vendor (menu group) ---
  {
    cliName: 'vendor-check',
    menuGroup: 'vendor',
    mcpTool: vendorCheckMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['vendor', 'check'],
  },
  {
    cliName: 'vendor-config',
    menuGroup: 'vendor',
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['vendor', 'config'],
  },
  // Writes into every target repo, so it is human-only rather than gated: no agent confirms a sync for a
  // human, and the apply also needs a real terminal on stdin. No tool definition, so no allowlist entry.
  {
    cliName: 'vendor-sync',
    menuGroup: 'vendor',
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    humanOnly: true,
    groupPath: ['vendor', 'sync'],
  },

  // --- Setup & Diagnostics (menu group) ---
  // `doctor` checks the machine; `audit` checks the REPO against its config rules. Both answer "is this
  // in a good state?". `setup` is the command that ACTS on those answers, which is why it leads the
  // group rather than sitting outside it.
  //
  // Sets the machine up in one pass: the local `initCore` writes, then install-or-update for the five
  // external tools. Exposed in the menu despite mutating, on the rule the catalog
  // already enforces: exposure is bounded by a tool's own invariants, not by the verb (`worktrees-add`
  // is exposed, ungated, and runs `pnpm install`). Here the invariant is computed —
  // `lib/dependency-install/risk-predicate` refuses any recipe needing sudo or piping a network-fetched
  // script, which is both bootstrap recipes, on every host regardless of configuration.
  //
  // `requiresHumanConfirm` rather than LOW_RISK_MUTATING_ALLOWLIST membership: the allowlist ASSERTS low
  // risk, and that would be a false claim for a command that installs software. It fires unconditionally
  // — `skipTools` included — because the read path that raises no prompt is `doctor`, a separate command
  // and therefore a separate permission identity.
  //
  // `menuGroup: 'setup'` REVERSES an earlier decision to hide the row, and the two reasons it rested on
  // are recorded here so they are not silently re-adopted:
  //   1. "It would be a one-keystroke installer" — `run-session.ts` spawns `[deps.cliPath,
  //      ...command.groupPath]` with ZERO flags, so the palette can only offer the flagless form, never
  //      the narrowed `setup --skip-tools`. That argument does not survive the catalog's own rule, which
  //      the far more consequential `release deploy-all` row already tests: exposure follows the
  //      invariant, and setup's is a converge that installs nothing sudo-shaped and is idempotent on a
  //      machine that is already set up.
  //   2. "The row would read a bare `setup` and collide with the `pnpm run setup` script" — the label is
  //      a render inside a palette the user reached by typing `ik`, where every other row is likewise
  //      unqualified (`doctor`, `audit`). A label ambiguity that exists only for a reader who ignores
  //      the surface they are standing in does not outweigh the command being undiscoverable.
  // The cost that decided it: `setup` reachable only from `--help` is a command most users never learn
  // exists. A human who wants the additive local writes without the installer still types
  // `infra-kit setup --skip-tools`.
  {
    cliName: 'setup',
    menuGroup: 'setup',
    mcpTool: setupMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['setup'],
  },
  {
    cliName: 'doctor',
    menuGroup: 'setup',
    mcpTool: doctorMcpTool,
    mcpExposed: true,
    // `mutating: false` is a statement about the FLAGLESS invocation the plugin grants
    // (`Bash(infra-kit doctor)`), not about every argv the command accepts. `--fix` chmods the token
    // store and prunes stale portless routes, and it is fenced by manifest U15: the grant is the bare
    // command, so an agent cannot reach `--fix` without a fresh permission prompt. Exactly the `audit`
    // precedent (`mutating: false` beside a CLI-only `--fix`), and pinned the same way — plus U-D2(b),
    // which drives the real `doctor()` and asserts the handler reaches zero `chmodSync` calls on a
    // fixture the CLI path demonstrably chmods.
    mutating: false,
    groupPath: ['doctor'],
  },
  {
    cliName: 'audit',
    menuGroup: 'setup',
    mcpTool: auditMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['audit'],
  },
  {
    cliName: 'version',
    menuGroup: 'setup',
    mcpTool: versionMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['version'],
  },

  // --- Not menu items (groups, long-running, or internal) ---
  // Bare groups: help + non-zero exit, so they never belong in the leaf-only menu.
  { cliName: 'vendor', menuGroup: null, mcpTool: null, mcpExposed: false, mutating: false, groupPath: ['vendor'] },
  { cliName: 'config', menuGroup: null, mcpTool: null, mcpExposed: false, mutating: false, groupPath: ['config'] },
  // env-token-set / env-token-remove carry NO tool definition (no schema to publish, no
  // `argument_required` payload to shape) and sit in LOW_RISK_MUTATING_ALLOWLIST below, so under
  // --agent they are ungated. The guard on the write is not a confirm: the host's permission prompt on
  // the argv, then `probeToken` (Doppler itself refuses a cross-config download) and `assertTokenScope`
  // (the payload must name this config) before `tokens.json` is touched. Removal is local-only — the
  // Doppler token survives and the next set puts it back.
  // menuGroup is null because both take a required `<env>` argument the no-arg menu cannot supply.
  {
    cliName: 'env-token-set',
    menuGroup: null,
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['env-token-set'],
  },
  {
    cliName: 'env-token-remove',
    menuGroup: null,
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['env-token-remove'],
  },
]

/**
 * Mutating commands that are DELIBERATELY exempt from the destructive-op confirm gate
 * (`mcpTool.requiresHumanConfirm`) because each is low-risk / reversible.
 *
 * Every command is agent-reachable over `Bash(infra-kit …)`, so the set this guards is `mutating`
 * alone — `mcpExposed` is historical and buys no exemption. Hand-maintained: adding a name here is
 * the ONLY sanctioned way to opt a mutating command out of the gate, and the default-deny test
 * (`command-catalog.test.ts`) reds CI for any mutating command that is neither gated nor listed here.
 * Every member carries a one-line justification so an audit reads at a glance.
 */
export const LOW_RISK_MUTATING_ALLOWLIST: readonly string[] = [
  // Overwrites the Jira fix-version description and the release PR body — reversible by re-editing;
  // no git/branch/deploy side effect.
  'release-edit',
  // Purely additive: creates worktrees for existing release branches; removing them is a separate op.
  'worktrees-add',
  // Reconciles the worktree set to the live release branches; recreatable via worktrees-add.
  'worktrees-sync',
  // Writes a load file under the infra-kit cache dir; cleared by env-clear, no remote/git effect.
  'env-load',
  // Writes one token into the local store; overwritten by the next set; no remote/git effect.
  'env-token-set',
  // Deletes one token from the local store; the Doppler token itself survives and env-token-set puts
  // it back; no remote/git effect.
  'env-token-remove',
  // Opens $EDITOR on the per-machine config override under ~/.infra-kit — a human is in the editor;
  // no remote/git effect.
  'config-edit',
  // Scaffolds the vendor config factory under ~/.infra-kit locally; no remote/git effect.
  'vendor-config',
  // Writes dev-context fragments and portless routes under ~/.infra-kit and runs local servers in the
  // foreground until Ctrl-C; no remote/git effect.
  'dev',
]

/**
 * Catalog entries for a menu group, in catalog (display) order.
 *
 * Yields ENTRIES, not names: every menu surface addresses a command by its {@link
 * CommandCatalogEntry.groupPath} (`['release','create']`), which is both what it renders and what it
 * spawns. `cliName` is an id — the tool name, which cannot hold a space — and is not a CLI surface.
 *
 * @example
 * getMenuGroupEntries('vendor').map((entry) => entry.groupPath.join(' ')) // => ['vendor check', …]
 */
export const getMenuGroupEntries = (group: MenuGroup): CommandCatalogEntry[] => {
  return commandCatalog.filter((entry) => {
    return entry.menuGroup === group
  })
}

/**
 * True when the invoked command runs until the user stops it (see {@link CommandCatalogEntry.longRunning}).
 * Keyed by the SPACE-JOINED Commander path (`'dev'`, `'vendor check'`) so it matches what `commandPath()`
 * hands the `postAction` hook, not the flat alias.
 *
 * @example
 * isLongRunningCommand('dev')          // => true  (no verdict to report; exits 128+signo)
 * isLongRunningCommand('vendor check') // => false
 */
export const isLongRunningCommand = (commandPath: string): boolean => {
  return commandCatalog.some((entry) => {
    return entry.longRunning === true && entry.groupPath.join(' ') === commandPath
  })
}
