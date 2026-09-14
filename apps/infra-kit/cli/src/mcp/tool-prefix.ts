/**
 * @fileoverview
 *
 * The ONLY place either tool prefix is spelled. Every other module — `version`, `doctor`, `audit`, the guidance
 * bodies — imports from here (plan docs/mcp-via-plugin-migration-plan.md §3.3, P6).
 *
 * WHY TWO PREFIXES. Claude Code names an MCP tool after the route that spawned its server: a server declared by
 * the plugin's `.mcp.json` is `mcp__plugin_<plugin>_<server>__<tool>`, one declared by a repo's `.mcp.json` is
 * `mcp__<server>__<tool>`. During the migration both routes exist — a repo whose `.mcp.json` still carries the
 * `infra-kit` key SHADOWS the plugin's server of the same key (measured, §6.1 S0-3), so that session's tools are
 * the legacy ones. The server therefore has to know which route spawned it, so `version` can report the prefix a
 * session actually has, or a skill reads guidance naming tools it does not have.
 *
 * HOW IT KNOWS. Claude Code sets `CLAUDE_PLUGIN_ROOT` for a plugin-spawned server and not for a `.mcp.json`-
 * spawned one (measured, §12 S1-5). That single variable is the launch signal; `resolveLaunch` reads it and
 * nothing else.
 *
 * The legacy constant and the `legacy` branch are deleted once the last consumer repo has dropped its key
 * (plan §9 follow-up 1).
 */

/** `<plugin name>` from `plugins/infra-kit/.claude-plugin/plugin.json` and the server key from `plugins/infra-kit/.mcp.json`; pinned to both files on disk by `tool-prefix.test.ts`. */
export const MCP_TOOL_PREFIX = 'mcp__plugin_infra-kit_infra-kit__'

/** The prefix a consumer's own `.mcp.json` entry (key `infra-kit`) produces — the route every repo is on until its key is removed. */
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
