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
}

/**
 * Authored in no-arg-menu display order so the interactive picker derives
 * directly from this list (see entry/cli.ts). MCP registration filters this
 * list by `mcpExposed`; MCP tool order is not contractual (clients address
 * tools by name), so the registration order need not match the array order.
 */
export const commandCatalog: CommandCatalogEntry[] = [
  // --- Release Management (menu group) ---
  { cliName: 'merge-dev', menuGroup: 'release', mcpTool: ghMergeDevMcpTool, mcpExposed: true },
  { cliName: 'release-list', menuGroup: 'release', mcpTool: ghReleaseListMcpTool, mcpExposed: true },
  { cliName: 'release-create', menuGroup: 'release', mcpTool: releaseCreateMcpTool, mcpExposed: true },
  { cliName: 'release-desc-edit', menuGroup: 'release', mcpTool: releaseDescEditMcpTool, mcpExposed: true },
  { cliName: 'release-deploy-all', menuGroup: 'release', mcpTool: ghReleaseDeployAllMcpTool, mcpExposed: true },
  {
    cliName: 'release-deploy-selected',
    menuGroup: 'release',
    mcpTool: ghReleaseDeploySelectedMcpTool,
    mcpExposed: true,
  },
  { cliName: 'release-deliver', menuGroup: 'release', mcpTool: ghReleaseDeliverMcpTool, mcpExposed: true },

  // --- Worktrees (menu group) ---
  { cliName: 'worktrees-add', menuGroup: 'worktrees', mcpTool: worktreesAddMcpTool, mcpExposed: true },
  { cliName: 'worktrees-list', menuGroup: 'worktrees', mcpTool: worktreesListMcpTool, mcpExposed: true },
  { cliName: 'worktrees-reload', menuGroup: 'worktrees', mcpTool: worktreesReloadMcpTool, mcpExposed: true },
  { cliName: 'worktrees-remove', menuGroup: 'worktrees', mcpTool: worktreesRemoveMcpTool, mcpExposed: true },
  { cliName: 'worktrees-sync', menuGroup: 'worktrees', mcpTool: worktreesSyncMcpTool, mcpExposed: true },

  // --- Environment (menu group) ---
  { cliName: 'audit', menuGroup: 'environment', mcpTool: auditMcpTool, mcpExposed: true },
  { cliName: 'vendor', menuGroup: 'environment', mcpTool: null, mcpExposed: false },
  { cliName: 'vendor-config', menuGroup: 'environment', mcpTool: null, mcpExposed: false },
  { cliName: 'doctor', menuGroup: 'environment', mcpTool: doctorMcpTool, mcpExposed: false },
  { cliName: 'init', menuGroup: 'environment', mcpTool: null, mcpExposed: false },
  { cliName: 'version', menuGroup: 'environment', mcpTool: versionMcpTool, mcpExposed: true },
  { cliName: 'config', menuGroup: 'environment', mcpTool: null, mcpExposed: false },
  { cliName: 'env-status', menuGroup: 'environment', mcpTool: envStatusMcpTool, mcpExposed: true },
  { cliName: 'env-list', menuGroup: 'environment', mcpTool: envListMcpTool, mcpExposed: true },
  { cliName: 'env-load', menuGroup: 'environment', mcpTool: envLoadMcpTool, mcpExposed: true },
  { cliName: 'env-clear', menuGroup: 'environment', mcpTool: envClearMcpTool, mcpExposed: true },
  // Internal shell-startup trigger; hidden from the menu and never an MCP tool
  // (it can't apply env to a shell — only the zsh integration sources the file).
  { cliName: 'env-autoload', menuGroup: null, mcpTool: null, mcpExposed: false },

  // --- vendor subcommands (not top-level menu items; MCP tools where applicable) ---
  { cliName: 'vendor-check', menuGroup: null, mcpTool: vendorCheckMcpTool, mcpExposed: true },
  { cliName: 'vendor-diff', menuGroup: null, mcpTool: vendorDiffMcpTool, mcpExposed: true },
  { cliName: 'vendor-manifest', menuGroup: null, mcpTool: vendorManifestMcpTool, mcpExposed: false },
  { cliName: 'vendor-sync', menuGroup: null, mcpTool: vendorSyncMcpTool, mcpExposed: false },
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
