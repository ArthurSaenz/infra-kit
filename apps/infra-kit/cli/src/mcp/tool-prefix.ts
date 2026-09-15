/**
 * @fileoverview
 *
 * The ONLY place either tool prefix is spelled. Every other module — `version`, `doctor`, `audit`, the guidance
 * bodies — imports from here (plan docs/archive/mcp/mcp-via-plugin-migration-plan.md §3.3, P6).
 *
 * WHY TWO PREFIXES. Claude Code names an MCP tool after the route that spawned its server: a server declared by
 * the plugin's `.mcp.json` is `mcp__plugin_<plugin>_<server>__<tool>`, one declared by a repo's `.mcp.json` is
 * `mcp__<server>__<tool>`. The plugin no longer declares one — it is skills-only, and the skills drive the CLI
 * over Bash (`.omc/plans/mcp-to-cli-skills-migration.md`) — so the canonical prefix names no live route any
 * more. It is kept because the server itself still runs, as a compatibility stub, for a consumer repo whose
 * own `.mcp.json` still carries the `infra-kit` key (Phases 1–2), and `version` has to report the prefix that
 * session actually has: the `plugin` branch stays reachable only from a served plugin copy that predates the
 * split (its `.mcp.json` is what `doctor` reports as stale).
 *
 * HOW IT KNOWS. Claude Code sets `CLAUDE_PLUGIN_ROOT` for a plugin-spawned server and not for a `.mcp.json`-
 * spawned one (measured, §12 S1-5). That single variable is the launch signal; `resolveLaunch` reads it and
 * nothing else.
 *
 * Both constants and both branches go with the server in Phase 3 (plan §3.11).
 */

/**
 * `<plugin name>` from `plugins/infra-kit/.claude-plugin/plugin.json` and the server key the plugin's
 * `.mcp.json` USED to carry. The file is gone, so the key is the literal `infra-kit` — the same key a
 * consumer's own entry uses — pinned by `tool-prefix.test.ts` to the plugin name on disk and the absence of
 * the file.
 */
export const MCP_TOOL_PREFIX = 'mcp__plugin_infra-kit_infra-kit__'

/** The prefix a consumer's own `.mcp.json` entry (key `infra-kit`) produces — the only route a repo that still carries the key is on. */
export const LEGACY_MCP_TOOL_PREFIX = 'mcp__infra-kit__'

export type McpLaunch = 'plugin' | 'legacy'

/**
 * Which route spawned this server. Read from `env` at call time (the `version` handler) — never at module
 * scope, so a process that builds the server more than once (`serveStdio` may) and a test that toggles the
 * variable both see the value that is live at call time, not the one cached at first import.
 *
 * @example
 * resolveLaunch({ CLAUDE_PLUGIN_ROOT: '/Users/me/.claude/plugins/cache/infra-kit/infra-kit/0.8.0' }) // => 'plugin'
 * resolveLaunch({}) // => 'legacy'
 */
export const resolveLaunch = (env: NodeJS.ProcessEnv): McpLaunch => {
  const root = env.CLAUDE_PLUGIN_ROOT

  return root !== undefined && root !== '' ? 'plugin' : 'legacy'
}

export const prefixFor = (launch: McpLaunch): string => {
  return launch === 'plugin' ? MCP_TOOL_PREFIX : LEGACY_MCP_TOOL_PREFIX
}
