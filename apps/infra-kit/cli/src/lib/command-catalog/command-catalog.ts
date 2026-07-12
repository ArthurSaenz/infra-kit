import type { z } from 'zod'

import { auditMcpTool } from 'src/commands/audit'
import { doctorMcpTool } from 'src/commands/doctor'
import { envClearMcpTool } from 'src/commands/env-clear'
import { envListMcpTool } from 'src/commands/env-list'
import { envLoadMcpTool } from 'src/commands/env-load'
import { envStatusMcpTool } from 'src/commands/env-status'
import { ghMergeDevMcpTool } from 'src/commands/gh-merge-dev'
import { ghReleaseDeliverMcpTool } from 'src/commands/gh-release-deliver'
import { ghReleaseDeployAllMcpTool } from 'src/commands/gh-release-deploy-all'
import { ghReleaseDeploySelectedMcpTool } from 'src/commands/gh-release-deploy-selected'
import { ghReleaseListMcpTool } from 'src/commands/gh-release-list'
import { releaseCreateMcpTool } from 'src/commands/release-create'
import { releaseDescEditMcpTool } from 'src/commands/release-desc-edit'
import { vendorCheckMcpTool } from 'src/commands/vendor-check'
import { vendorDiffMcpTool } from 'src/commands/vendor-diff'
import { vendorManifestMcpTool } from 'src/commands/vendor-manifest'
import { vendorSyncMcpTool } from 'src/commands/vendor-sync'
import { versionMcpTool } from 'src/commands/version'
import { worktreesAddMcpTool } from 'src/commands/worktrees-add'
import { worktreesListMcpTool } from 'src/commands/worktrees-list'
import { worktreesReloadMcpTool } from 'src/commands/worktrees-reload'
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
  // Heterogeneous tool params; loose `any` mirrors the existing tool-handler typing.
  handler: (params: any) => Promise<ToolsExecutionResult>
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

/** Top-level menu group for the no-arg interactive picker (null = not shown). */
export type MenuGroup = 'release' | 'worktrees' | 'environment'

export interface CommandCatalogEntry {
  /** CLI command name as registered in Commander (flat form, e.g. `merge-dev`). */
  cliName: string
  /** Menu group, or null for subcommands not shown at the top level. */
  menuGroup: MenuGroup | null
  /** The co-located MCP tool, or null for CLI-only commands (init/config/vendor group). */
  mcpTool: CatalogMcpTool | null
  /**
   * Whether the command is registered as an MCP tool. Explicit allowlist:
   * `doctor`, `vendor-sync`, and `vendor-manifest` are deliberately UNEXPOSED
   * (vendor-sync/manifest mutate consumer repos; doctor is host-inspecting), so
   * they must never become agent-callable by accident.
   */
  mcpExposed: boolean
  /**
   * Canonical Commander argv for this command (grouped form, e.g. `['vendor','check']`). The session
   * shell spawns `infra-kit <...groupPath>` so a menu pick runs the preferred grouped surface (not the
   * deprecated/hidden flat alias) and shows that as the replayable equivalent line.
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
}

/**
 * Authored in no-arg-menu display order so the interactive picker derives
 * directly from this list (see entry/cli.ts). MCP registration filters this
 * list by `mcpExposed`; MCP tool order is not contractual (clients address
 * tools by name), so the registration order need not match the array order.
 */
export const commandCatalog: CommandCatalogEntry[] = [
  // --- Release Management (menu group) ---
  {
    cliName: 'merge-dev',
    menuGroup: 'release',
    mcpTool: ghMergeDevMcpTool,
    mcpExposed: true,
    groupPath: ['release', 'merge-dev'],
  },
  {
    cliName: 'release-list',
    menuGroup: 'release',
    mcpTool: ghReleaseListMcpTool,
    mcpExposed: true,
    groupPath: ['release', 'list'],
  },
  {
    cliName: 'release-create',
    menuGroup: 'release',
    mcpTool: releaseCreateMcpTool,
    mcpExposed: true,
    groupPath: ['release', 'create'],
  },
  {
    cliName: 'release-desc-edit',
    menuGroup: 'release',
    mcpTool: releaseDescEditMcpTool,
    mcpExposed: true,
    groupPath: ['release', 'desc-edit'],
  },
  {
    cliName: 'release-deploy-all',
    menuGroup: 'release',
    mcpTool: ghReleaseDeployAllMcpTool,
    mcpExposed: true,
    groupPath: ['release', 'deploy-all'],
  },
  {
    cliName: 'release-deploy-selected',
    menuGroup: 'release',
    mcpTool: ghReleaseDeploySelectedMcpTool,
    mcpExposed: true,
    groupPath: ['release', 'deploy-selected'],
  },
  // release-deliver does prod delivery + admin-merge — genuinely irreversible,
  // so it is CLI-only by design (mirrors the vendor-sync/manifest rationale).
  {
    cliName: 'release-deliver',
    menuGroup: 'release',
    mcpTool: ghReleaseDeliverMcpTool,
    mcpExposed: false,
    groupPath: ['release', 'deliver'],
  },

  // --- Worktrees (menu group) ---
  {
    cliName: 'worktrees-add',
    menuGroup: 'worktrees',
    mcpTool: worktreesAddMcpTool,
    mcpExposed: true,
    groupPath: ['worktrees', 'add'],
  },
  {
    cliName: 'worktrees-list',
    menuGroup: 'worktrees',
    mcpTool: worktreesListMcpTool,
    mcpExposed: true,
    groupPath: ['worktrees', 'list'],
  },
  {
    cliName: 'worktrees-reload',
    menuGroup: 'worktrees',
    mcpTool: worktreesReloadMcpTool,
    mcpExposed: true,
    groupPath: ['worktrees', 'reload'],
  },
  // worktrees-remove runs `git worktree remove` on each leaf worktree —
  // genuinely irreversible (uncommitted work is lost), so it is CLI-only by
  // design (mirrors the vendor-sync/manifest rationale).
  {
    cliName: 'worktrees-remove',
    menuGroup: 'worktrees',
    mcpTool: worktreesRemoveMcpTool,
    mcpExposed: false,
    groupPath: ['worktrees', 'remove'],
  },
  {
    cliName: 'worktrees-sync',
    menuGroup: 'worktrees',
    mcpTool: worktreesSyncMcpTool,
    mcpExposed: true,
    groupPath: ['worktrees', 'sync'],
  },

  // --- Environment (menu group) ---
  // Every menu-eligible entry must be a Commander LEAF (an action, no subcommands) so the session
  // shell's report discriminator holds. The bare `vendor`/`config` GROUPS are menuGroup:null — a bare
  // group prints help and exits non-zero, which the shell would misreport. Their useful leaves
  // (vendor-check/diff/config, config-path/edit) are surfaced here instead, each with a hidden flat
  // Commander alias (see src/lib/program/program.ts) so the palette can introspect + single-token dispatch.
  { cliName: 'audit', menuGroup: 'environment', mcpTool: auditMcpTool, mcpExposed: true, groupPath: ['audit'] },
  {
    cliName: 'vendor-check',
    menuGroup: 'environment',
    mcpTool: vendorCheckMcpTool,
    mcpExposed: true,
    groupPath: ['vendor', 'check'],
  },
  {
    cliName: 'vendor-diff',
    menuGroup: 'environment',
    mcpTool: vendorDiffMcpTool,
    mcpExposed: true,
    groupPath: ['vendor', 'diff'],
  },
  {
    cliName: 'vendor-config',
    menuGroup: 'environment',
    mcpTool: null,
    mcpExposed: false,
    groupPath: ['vendor', 'config'],
  },
  { cliName: 'config-path', menuGroup: 'environment', mcpTool: null, mcpExposed: false, groupPath: ['config', 'path'] },
  {
    cliName: 'config-edit',
    menuGroup: 'environment',
    mcpTool: null,
    mcpExposed: false,
    groupPath: ['config', 'edit'],
    entersAltScreen: true,
  },
  { cliName: 'doctor', menuGroup: 'environment', mcpTool: doctorMcpTool, mcpExposed: false, groupPath: ['doctor'] },
  { cliName: 'init', menuGroup: 'environment', mcpTool: null, mcpExposed: false, groupPath: ['init'] },
  { cliName: 'version', menuGroup: 'environment', mcpTool: versionMcpTool, mcpExposed: true, groupPath: ['version'] },
  {
    cliName: 'env-status',
    menuGroup: 'environment',
    mcpTool: envStatusMcpTool,
    mcpExposed: true,
    groupPath: ['env-status'],
  },
  { cliName: 'env-list', menuGroup: 'environment', mcpTool: envListMcpTool, mcpExposed: true, groupPath: ['env-list'] },
  {
    cliName: 'env-load',
    menuGroup: 'environment',
    mcpTool: envLoadMcpTool,
    mcpExposed: true,
    groupPath: ['env-load'],
    sessionEnvNotice: true,
  },
  {
    cliName: 'env-clear',
    menuGroup: 'environment',
    mcpTool: envClearMcpTool,
    mcpExposed: true,
    groupPath: ['env-clear'],
    sessionEnvNotice: true,
  },

  // --- Not menu items (groups, long-running, or internal) ---
  // Bare groups: help + non-zero exit, so they never belong in the leaf-only menu.
  { cliName: 'vendor', menuGroup: null, mcpTool: null, mcpExposed: false, groupPath: ['vendor'] },
  { cliName: 'config', menuGroup: null, mcpTool: null, mcpExposed: false, groupPath: ['config'] },
  // Long-running local dev server (fastify + chokidar). Not an MCP tool — it never
  // returns, so it can't fit the request/response tool contract. menuGroup null:
  // the no-arg picker drives one-shot commands, not a blocking foreground process.
  { cliName: 'dev', menuGroup: null, mcpTool: null, mcpExposed: false, groupPath: ['dev'] },
  // Internal shell-startup trigger; hidden from the menu and never an MCP tool
  // (it can't apply env to a shell — only the zsh integration sources the file).
  { cliName: 'env-autoload', menuGroup: null, mcpTool: null, mcpExposed: false, groupPath: ['env-autoload'] },
  // The MCP boundary auto-confirms every tool, so an agent-triggered unattended global package install
  // must never be reachable there. menuGroup null keeps it off the no-arg picker too — updating the CLI
  // is a deliberate act, not something to land on by arrowing through a menu.
  { cliName: 'self-update', menuGroup: null, mcpTool: null, mcpExposed: false, groupPath: ['self-update'] },
  // Launcher for the MCP server itself; it blocks on a stdio transport, so it is neither a one-shot menu
  // command nor expressible as a request/response tool.
  { cliName: 'mcp', menuGroup: null, mcpTool: null, mcpExposed: false, groupPath: ['mcp'] },

  // --- vendor subcommands (not top-level menu items; MCP tools where applicable) ---
  {
    cliName: 'vendor-manifest',
    menuGroup: null,
    mcpTool: vendorManifestMcpTool,
    mcpExposed: false,
    groupPath: ['vendor', 'manifest'],
  },
  {
    cliName: 'vendor-sync',
    menuGroup: null,
    mcpTool: vendorSyncMcpTool,
    mcpExposed: false,
    groupPath: ['vendor', 'sync'],
  },
]

/** The MCP tools to register: catalog entries that are exposed and carry a tool. */
export const getExposedMcpTools = (): CatalogMcpTool[] => {
  return commandCatalog.flatMap((entry) => {
    return entry.mcpExposed && entry.mcpTool ? [entry.mcpTool] : []
  })
}

/** CLI command names for a menu group, in catalog (display) order. */
export const getMenuGroupCommands = (group: MenuGroup): string[] => {
  return commandCatalog.flatMap((entry) => {
    return entry.menuGroup === group ? [entry.cliName] : []
  })
}
