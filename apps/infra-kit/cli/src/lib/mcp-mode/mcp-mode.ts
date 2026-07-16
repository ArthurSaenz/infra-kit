/**
 * MCP-mode flag for the CLI. `process.stdin` is the JSON-RPC transport when the
 * binary runs as an MCP server, so anything that would read keystrokes from it
 * (raw `data` listeners, Ink screens, `@inquirer` prompts) must be gated off.
 *
 * This exists because `process.stdin.isTTY` CANNOT answer that question:
 * `commands/mcp/mcp.ts` spawns the server with `stdio: 'inherit'`, so a
 * terminal-launched `infra-kit mcp` hands the child a real TTY stdin and an
 * isTTY-keyed guard does not fire. Piped stdio (how Claude Code spawns it) only
 * makes isTTY look sufficient by coincidence.
 *
 * Set in `createMcpServer()` — the importable, transport-free entry that every
 * MCP launch goes through — not in `entry/mcp.ts`, which starts a server at
 * module scope and so can never assert the flag was actually set.
 */

/** Mutable holder (object so `prefer-const` holds while the flag toggles per run). */
export const mcpMode = { enabled: false }

/** True when this process is serving MCP, i.e. `process.stdin` carries JSON-RPC. */
export const isMcpMode = (): boolean => {
  return mcpMode.enabled
}
