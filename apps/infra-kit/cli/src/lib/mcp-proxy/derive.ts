import type { McpProxySpec } from 'src/lib/infra-kit-config'

/** The bin the derived `.mcp.json` entries point at; also how ownership of an entry is recognised. */
export const IK_MCP_COMMAND = 'ik-mcp'

/** Exactly the fields a derived entry carries — Claude Code's stdio server shape. */
export interface DerivedMcpEntry {
  type: 'stdio'
  command: typeof IK_MCP_COMMAND
  args: string[]
}

/**
 * The argv `ik-mcp` is spawned with for one configured server.
 *
 * Repeated flags with one value each, never comma lists: a value can hold a comma, and only a
 * one-value-per-flag encoding stays unambiguous. `--unset` is emitted only for a non-empty list,
 * which the goldens pin because the parser shares that convention and would otherwise agree with
 * any wrong answer. Everything after `--` is the upstream's own command, verbatim.
 */
export const deriveMcpEntry = (name: string, spec: McpProxySpec): DerivedMcpEntry => {
  const args = ['--name', name]

  for (const variable of spec.env) args.push('--env', variable)
  for (const variable of spec.unset) args.push('--unset', variable)

  args.push('--', spec.command, ...spec.args)

  return { type: 'stdio', command: IK_MCP_COMMAND, args }
}
