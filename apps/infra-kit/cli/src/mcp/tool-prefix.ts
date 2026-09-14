/**
 * @fileoverview
 *
 * The ONLY place either tool prefix is spelled. Every other module — resource descriptions, the served workflow
 * bodies, `version`, `doctor` — imports from here (plan docs/mcp-via-plugin-migration-plan.md §3.3, P6).
 *
 * WHY TWO PREFIXES. Claude Code names an MCP tool after the route that spawned its server: a server declared by
 * the plugin's `.mcp.json` is `mcp__plugin_<plugin>_<server>__<tool>`, one declared by a repo's `.mcp.json` is
 * `mcp__<server>__<tool>`. During the migration both routes exist — a repo whose `.mcp.json` still carries the
 * `infra-kit` key SHADOWS the plugin's server of the same key (measured, §6.1 S0-3), so that session's tools are
 * the legacy ones. The server therefore has to know which route spawned it, and render every tool name it serves
 * accordingly, or a session reads guidance naming tools it does not have.
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
 * Which route spawned this server. Read from `env` inside `createMcpServer()` — never at module scope, so a
 * process that builds the server more than once (`serveStdio` may) and a test that toggles the variable both see
 * the value that is live at build time, not the one cached at first import.
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

/**
 * The fully scoped name of one of this server's tools, as the session that spawned it sees it.
 *
 * @example
 * toolName('release-create', 'plugin') // => 'mcp__plugin_infra-kit_infra-kit__release-create'
 * toolName('release-create', 'legacy') // => 'mcp__infra-kit__release-create'
 */
export const toolName = (name: string, launch: McpLaunch): string => {
  return `${prefixFor(launch)}${name}`
}

/**
 * A served body, spelled for the session's route. Bodies are AUTHORED in the canonical (plugin) spelling — plain
 * literals in `resources/workflow/*.md`, which prettier owns, so no template token — and the legacy route is one
 * substitution of one constant at serve time. Pure: the same input and launch always give the same output.
 *
 * @example
 * renderForLaunch('call mcp__plugin_infra-kit_infra-kit__env-load', 'legacy') // => 'call mcp__infra-kit__env-load'
 */
export const renderForLaunch = (body: string, launch: McpLaunch): string => {
  return launch === 'plugin' ? body : body.replaceAll(MCP_TOOL_PREFIX, LEGACY_MCP_TOOL_PREFIX)
}
