import type { z } from 'zod'

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

/**
 * One command's cross-surface metadata: its canonical names, the menu group it shows in, the tool
 * definition whose schema shapes an agent's `argument_required` refusal, and the `mutating` flag the
 * confirm gate keys off. Declared beside the command's Commander wiring in `entry/program/register/`,
 * which stays the source of truth for argument parsing.
 */
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
   * sit in `LOW_RISK_MUTATING_ALLOWLIST` (`command-catalog.ts`).
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
