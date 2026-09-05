import type { z } from 'zod'

import { auditMcpTool } from 'src/commands/audit'
import { configGetMcpTool } from 'src/commands/config-get'
import { devStatusMcpTool } from 'src/commands/dev-status'
import { doctorMcpTool } from 'src/commands/doctor'
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
import { releaseDescEditMcpTool } from 'src/commands/release-desc-edit'
import { reopenMcpTool } from 'src/commands/reopen'
import { vendorCheckMcpTool } from 'src/commands/vendor-check'
import { versionMcpTool } from 'src/commands/version'
import { worktreesAddMcpTool } from 'src/commands/worktrees-add'
import { worktreesListMcpTool } from 'src/commands/worktrees-list'
import { worktreesRemoveMcpTool } from 'src/commands/worktrees-remove'
import { worktreesSyncMcpTool } from 'src/commands/worktrees-sync'
import type { ToolsExecutionResult } from 'src/types'

/**
 * Registration-facing shape of an MCP tool. The concrete `*McpTool` definitions
 * are generic over their Zod input/output shapes (and invariant), so they cannot
 * share one precise `McpTool<...>` element type in an array. This widened, non-
 * generic view exposes exactly what registration needs and every concrete tool
 * assigns to it. Matches the loose handler typing already used in tool-handler.
 */
export interface CatalogMcpTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  outputSchema: z.ZodRawShape
  /**
   * Marks a destructive tool for the orthogonal MCP confirm gate in `lib/tool-handler`. Widened,
   * non-generic mirror of {@link McpTool.requiresHumanConfirm} so registration (`mcp/tools/index.ts`)
   * can forward it to `createToolHandler` without reaching into the concrete generic tool type.
   */
  requiresHumanConfirm?: boolean
  // Heterogeneous tool params; loose `any` mirrors the existing tool-handler typing.
  handler: (params: any) => Promise<ToolsExecutionResult>
}

/**
 * Structural mirror of the SDK's `ToolAnnotations`. Deliberately NOT imported from
 * `@modelcontextprotocol/server`: this module is on every CLI command path, and the `u6`/`u7` bundle
 * guards depend on the catalog staying free of MCP SDK imports.
 *
 * These are ADVISORY hints — the MCP spec states a client must not make security decisions from them.
 * The authority for destructive operations remains `requiresHumanConfirm` plus the confirm gate in
 * `lib/tool-handler`; nothing in that gate reads these fields.
 *
 * `idempotentHint` is deliberately absent: with no tool claiming `true`, an explicit `false` is
 * indistinguishable from omission under both host-reading conventions, and the hint licenses retry —
 * the one place where over-claiming is dangerous rather than merely noisy.
 */
export interface McpToolAnnotations {
  readOnlyHint: boolean
  /** Present iff `readOnlyHint` is false — the spec makes it meaningless on a read-only tool. */
  destructiveHint?: boolean
  openWorldHint: boolean
}

/** A catalog tool plus the registration-facing metadata {@link getExposedMcpTools} derives for it. */
export interface RegistrableMcpTool extends CatalogMcpTool {
  title: string
  annotations: McpToolAnnotations
}

/**
 * Single source of truth for the CLI command surface. It consolidates what used
 * to live in three hand-maintained places (the MCP `tools[]` array and the
 * three no-arg-menu name arrays) into one list, so they can no longer drift.
 *
 * It does NOT replace Commander's `.command().option()` wiring in entry/cli.ts —
 * that stays the source of truth for argument parsing. This catalog only carries
 * cross-surface metadata: the canonical names, which menu group a command shows
 * in, and whether the command is exposed as an MCP tool.
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
   * Stable flat id for the command (`release-create`), and the name its MCP tool registers under — MCP
   * tool names cannot contain a space, so the grouped path cannot serve as one.
   *
   * NOT a CLI surface: the CLI registers only the grouped form ({@link groupPath}). Flat Commander
   * commands were removed once every menu surface learned to address a command by its group path.
   */
  cliName: string
  /** Menu group, or null for subcommands not shown at the top level. */
  menuGroup: MenuGroup | null
  /** The co-located MCP tool, or null for CLI-only commands (init/config/vendor group). */
  mcpTool: CatalogMcpTool | null
  /**
   * Whether the command is registered as an MCP tool. Explicit allowlist:
   * `doctor` is deliberately UNEXPOSED (host-inspecting), so it must never become
   * agent-callable by accident.
   */
  mcpExposed: boolean
  /**
   * Whether running this command writes git/remote/consumer-repo/Doppler-env/fs-outside-cache state.
   * Drives the MCP destructive-op gate (Phase 4).
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
}

/**
 * Authored in no-arg-menu display order so the interactive picker derives
 * directly from this list (see entry/cli.ts). MCP registration filters this
 * list by `mcpExposed`; MCP tool order is not contractual (clients address
 * tools by name), so the registration order need not match the array order.
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
  // Not an MCP tool: it never returns a result, so it cannot fit the request/response tool contract.
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
  // menuGroup 'develop' so it renders beside `dev` in the palette (same shape as reopen/env-status).
  {
    cliName: 'dev-status',
    menuGroup: 'develop',
    mcpTool: devStatusMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['dev-status'],
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
    cliName: 'release-desc-edit',
    menuGroup: 'release',
    mcpTool: releaseDescEditMcpTool,
    mcpExposed: true,
    mutating: true,
    groupPath: ['release', 'desc-edit'],
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
  // so it is CLI-only by design.
  {
    cliName: 'release-deliver',
    menuGroup: 'release',
    mcpTool: ghReleaseDeliverMcpTool,
    mcpExposed: false,
    mutating: true,
    groupPath: ['release', 'deliver'],
  },
  // The CLI commands behind these two are DEPRECATED aliases of `release deploy-* --from local`,
  // so `menuGroup: null` keeps them out of the palette while they still resolve for anyone who types
  // them. The MCP tools are deliberately NOT folded into the release pair: the MCP boundary
  // auto-confirms every call (`tool-handler`), and `local-deploy-selected` requires `service` with
  // `.min(1)` — a merged tool would have to relax that, and an agent omitting it would deploy
  // everything. Agent-reachable while human-unbrowsable is the intended end state here.
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
  // `reopen` is a top-level command (`infra-kit reopen`, groupPath ['reopen']) but carries
  // menuGroup 'worktrees' so it renders alongside its kin in the palette — the same single-segment
  // top-level + non-matching-menuGroup shape as env-status/env-load (['env-status'] + 'environment').
  {
    cliName: 'reopen',
    menuGroup: 'worktrees',
    mcpTool: reopenMcpTool,
    mcpExposed: true,
    mutating: false,
    groupPath: ['reopen'],
  },
  // worktrees-remove runs `git worktree remove` (no --force) on the named leaf worktrees. It is NOT
  // irreversible in the way release-deliver is: the release branches/commits survive, the
  // worktrees scaffold is left in place, and worktrees-add recreates a removed worktree. git also
  // refuses to remove a worktree with modified-tracked or untracked files. The residual risk —
  // deletion of gitignored local state (a hydrated `.env` of Doppler secrets, node_modules/dist) — is
  // contained by the tool's own invariants rather than by withholding it: over MCP it rejects
  // all=true (no one-shot wipe) and errors on any unmatched target before removing anything. So it is
  // exposed, unlike the genuinely-irreversible release-deliver. After a refused removal it sweeps
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

  // --- Setup & Diagnostics (menu group) ---
  // `init`/`doctor` set the machine up and check it; `audit` checks the REPO against its config rules.
  // Both answer "is this in a good state?", which is why they sit together.
  { cliName: 'init', menuGroup: 'setup', mcpTool: null, mcpExposed: false, mutating: true, groupPath: ['init'] },
  {
    cliName: 'doctor',
    menuGroup: 'setup',
    mcpTool: doctorMcpTool,
    mcpExposed: false,
    mutating: true,
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
  // Internal shell-startup trigger; hidden from the menu and never an MCP tool
  // (it can't apply env to a shell — only the zsh integration sources the file).
  {
    cliName: 'env-autoload',
    menuGroup: null,
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['env-autoload'],
  },
  // env-token-set / env-token-remove carry NO MCP tool at all — not merely `mcpExposed: false`, so
  // there is nothing to accidentally flip on. `lib/tool-handler` injects `confirmedCommand: true` into
  // EVERY tool call, so the MCP boundary auto-confirms by construction: an agent must never be one call
  // away from WRITING a credential or DESTROYING one. Same argument that keeps `doctor --fix` CLI-only.
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
  // The MCP boundary auto-confirms every tool, so an agent-triggered unattended global package install
  // must never be reachable there. menuGroup null keeps it off the no-arg picker too — updating the CLI
  // is a deliberate act, not something to land on by arrowing through a menu.
  {
    cliName: 'self-update',
    menuGroup: null,
    mcpTool: null,
    mcpExposed: false,
    mutating: true,
    groupPath: ['self-update'],
  },
  // Launcher for the MCP server itself; it blocks on a stdio transport, so it is neither a one-shot menu
  // command nor expressible as a request/response tool.
  { cliName: 'mcp', menuGroup: null, mcpTool: null, mcpExposed: false, mutating: false, groupPath: ['mcp'] },
]

/**
 * Mutating, MCP-exposed tools that are DELIBERATELY exempt from the destructive-op confirm gate
 * (`mcpTool.requiresHumanConfirm`) because each is low-risk / reversible. Hand-maintained: adding a
 * name here is the ONLY sanctioned way to opt a mutating exposed tool out of the gate, and the
 * default-deny test (`command-catalog.test.ts`) reds CI for any mutating+exposed tool that is neither
 * gated nor listed here. Every member carries a one-line justification so an audit reads at a glance.
 */
export const LOW_RISK_MUTATING_ALLOWLIST: readonly string[] = [
  // Overwrites the Jira fix-version description and the release PR body — reversible by re-editing;
  // no git/branch/deploy side effect.
  'release-desc-edit',
  // Purely additive: creates worktrees for existing release branches; removing them is a separate op.
  'worktrees-add',
  // Reconciles the worktree set to the live release branches; recreatable via worktrees-add.
  'worktrees-sync',
  // Writes a load file under the infra-kit cache dir; cleared by env-clear, no remote/git effect.
  'env-load',
]

// `openWorld` is DECLARED rather than derived because neither candidate derivation is sound. An
// import-graph check produces false NEGATIVES on the four deploy tools (they reach GitHub/AWS through
// `zx` with no `src/integrations/*` import at all — an error in the dangerous direction on the most
// dangerous tools in the catalog) and false POSITIVES on `env-list` and `worktrees-remove` (which
// import an integration module whose MCP-reachable path never calls out). The per-row call-site
// citation IS the control: nobody can write "never calls Doppler" next to `env-token-list.ts:115-131`.
//
// Allowlist membership and `destructiveHint` are independent — all four LOW_RISK_MUTATING_ALLOWLIST
// members read destructive. The allowlist answers "is a confirm prompt warranted?"; the hint answers
// "does this perform destructive updates?".
/** Display title and the one annotation nothing derives (`openWorld`), per exposed tool. */
export const MCP_TOOL_PRESENTATION: Record<string, { title: string; openWorld: boolean }> = {
  // --- Read-only ---
  // Reads on-disk dev-context fragments; the TCP liveness probe is loopback-only (dev-status.ts:178).
  'dev-status': { title: 'Dev server status', openWorld: false },
  // gh-release-list.ts:13 getReleasePRsWithInfo(); getJiraDescriptions imported :6.
  'gh-release-list': { title: 'Open releases', openWorld: true },
  // worktrees-list.ts:38 Promise.all([getReleasePRsWithInfo(), getJiraDescriptions()]).
  'worktrees-list': { title: 'Release worktrees', openWorld: true },
  // env-status.ts:94 — "Pure local introspection — makes NO Doppler call".
  'env-status': { title: 'Loaded environment', openWorld: false },
  // env-list.ts:147 — "never a live Doppler probe". The :4 doppler import is getDopplerProject, which
  // reads getInfraKitConfig() and returns a name (doppler-project.ts:23-27) — no network.
  'env-list': { title: 'Available environments', openWorld: false },
  // env-token-list.ts:115-131 probeEnvToken per environment, and `check` is in the MCP inputSchema
  // (:173-176), so the probe is agent-reachable.
  'env-token-list': { title: 'Doppler service tokens', openWorld: true },
  // config-get.ts:58 — "Read-only introspection … use `config edit` (CLI-only) to modify".
  'config-get': { title: 'Merged infra-kit config', openWorld: false },
  // vendor-check.ts:120 — "Self-contained (no source repo or config needed)".
  'vendor-check': { title: 'Vendor checksum check', openWorld: false },
  // audit.ts:242-255 reads workspace manifests; --fix/--design are unreachable through the MCP schema.
  audit: { title: 'Package audit', openWorld: false },
  // Reads packageJson.version; no registry check.
  version: { title: 'CLI version', openWorld: false },

  // --- Mutating, gated ---
  // gh-merge-dev.ts:355 getReleasePRsWithInfo(); pushes to remote release branches.
  'gh-merge-dev': { title: 'Merge dev into release branches', openWorld: true },
  // release-create.ts:7 loadJiraConfig from src/integrations/jira; creates branches and PRs.
  'release-create': { title: 'Create releases', openWorld: true },
  // gh-release-deploy-all.ts:2 `import { $ } from 'zx'` — dispatches deploy-all.yml via the gh CLI.
  // Imports NO src/integrations/*, which is why the import-graph derivation was rejected.
  'gh-release-deploy-all': { title: 'Deploy all services (CI)', openWorld: true },
  // gh-release-deploy-selected.ts:6 `import { $ } from 'zx'` — dispatches deploy-selected-services.yml
  // via the gh CLI. Same import shape as deploy-all: no src/integrations/* to spot.
  'gh-release-deploy-selected': { title: 'Deploy selected services (CI)', openWorld: true },
  // local-deploy.ts runs devops/scripts/deploy-*.sh against AWS via zx; no src/integrations/* import.
  'local-deploy-all': { title: 'Deploy all services from this machine', openWorld: true },
  // local-deploy.ts:503 shares the same body as local-deploy-all (:304-321), running
  // devops/scripts/deploy-<name>.sh against the authenticated AWS account via zx.
  'local-deploy-selected': { title: 'Deploy selected services from this machine', openWorld: true },
  // The only network path is worktrees-remove.ts:130, inside the picker `else` branch at :129-141.
  // That branch is unreachable via MCP twice over: the inputSchema declares `versions` REQUIRED and
  // omits `all` entirely, and assertMcpRemovalInput (:39-57, called at :97) throws under isMcpMode()
  // on `all` and on missing `versions`.
  'worktrees-remove': { title: 'Remove release worktrees', openWorld: false },
  // Emits `unset` statements into a local shell script and returns its path; the whole output surface
  // (filePath, unsetStatements, variableCount, purged) is local-file shaped, with no remote to contact.
  'env-clear': { title: 'Clear environment variables', openWorld: false },

  // --- Mutating, ungated (LOW_RISK_MUTATING_ALLOWLIST members — still destructive) ---
  // release-desc-edit.ts:180 updateJiraVersion, :185 updateReleasePRBody. Overwrites existing text in
  // two systems.
  'release-desc-edit': { title: 'Edit release description', openWorld: true },
  // worktrees-add.ts:82 getReleasePRsWithInfo(); :301 `pnpm install`. Additive in fact (existing
  // worktrees are skipped, not errored) — reads destructive under the uniform derivation, the single
  // accepted over-claim.
  'worktrees-add': { title: 'Add release worktrees', openWorld: true },
  // worktrees-sync.ts:45 getReleasePRs(). "Only removes — never creates".
  'worktrees-sync': { title: 'Prune stale worktrees', openWorld: true },
  // env-load.ts:17 imports src/integrations/doppler and downloads secrets. Destructive: :192
  // "atomically write env-load.sh" into getSessionCacheDir() (:212) — a path deterministic per
  // terminal session, so loading `dev` after `prod` OVERWRITES.
  'env-load': { title: 'Load environment variables', openWorld: true },

  // --- Not-read-only exception ---
  // Spawns local editor and cmux processes on this machine; every output field (worktreePaths,
  // ideProviders, cmuxOpened/Skipped/Closed) describes local window state and contacts no remote.
  reopen: { title: 'Reopen project windows', openWorld: false },
}

/**
 * Tools that modify machine state the {@link CommandCatalogEntry.mutating} predicate deliberately
 * excludes — it covers only git/remote/consumer-repo/Doppler-env/fs-outside-cache state.
 *
 * This array may ONLY ever TIGHTEN a hint toward the spec default of `readOnlyHint: false`; it can
 * never loosen one, because it is applied as a negation. `reopen` is `mutating: false` yet its
 * MCP-reachable `force` flag closes cmux workspaces ("Close each cmux workspace first, then reopen
 * (disruptive)") and reports them in `cmuxClosed`. Pinned by the T7 catalog test.
 */
export const NOT_READ_ONLY: readonly string[] = ['reopen']

/**
 * The MCP tools to register: catalog entries that are exposed and carry a tool, each widened with the
 * display title and the protocol annotations derived from the catalog's own fields.
 *
 * `readOnlyHint` is DERIVED from `mutating` rather than hand-typed, so it cannot silently disagree
 * with the field the confirm gate keys off. `destructiveHint` follows from it: present as `true` on
 * every write tool, absent on every read tool (the spec makes it meaningless there). Only `title` and
 * `openWorldHint` are declared, in {@link MCP_TOOL_PRESENTATION}.
 *
 * The returned objects are SPREAD COPIES — `{ ...entry.mcpTool, title, annotations }` — not the
 * catalog's `mcpTool` object identities. `handler` survives as a reference, so dispatch is unaffected,
 * but never write an identity comparison against `entry.mcpTool` on the strength of this return value.
 */
export const getExposedMcpTools = (): RegistrableMcpTool[] => {
  return commandCatalog.flatMap((entry) => {
    if (!entry.mcpExposed || !entry.mcpTool) {
      return []
    }

    const presentation = MCP_TOOL_PRESENTATION[entry.mcpTool.name]

    // Scoped HERE rather than at module scope on purpose: this module is imported by every CLI command
    // path, so a module-scope throw on a table typo would take down every command instead of only MCP
    // registration. The T1/T3 catalog tests already red CI for a missing row.
    if (!presentation) {
      throw new Error(
        `No MCP_TOOL_PRESENTATION entry for exposed tool "${entry.mcpTool.name}" — add a title and an evidence-cited openWorld value in command-catalog.ts.`,
      )
    }

    const readOnlyHint = !entry.mutating && !NOT_READ_ONLY.includes(entry.mcpTool.name)

    return [
      {
        ...entry.mcpTool,
        title: presentation.title,
        annotations: {
          readOnlyHint,
          ...(readOnlyHint ? {} : { destructiveHint: true }),
          openWorldHint: presentation.openWorld,
        },
      },
    ]
  })
}

/**
 * Catalog entries for a menu group, in catalog (display) order.
 *
 * Yields ENTRIES, not names: every menu surface addresses a command by its {@link
 * CommandCatalogEntry.groupPath} (`['release','create']`), which is both what it renders and what it
 * spawns. `cliName` is an id — the MCP tool name, which cannot hold a space — and is not a CLI surface.
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
