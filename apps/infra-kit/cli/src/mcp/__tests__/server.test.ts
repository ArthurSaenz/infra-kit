import { afterEach, describe, expect, it } from 'vitest'

import { mcpMode } from 'src/lib/mcp-mode'

import packageJson from '../../../package.json' with { type: 'json' }
import { createMcpServer } from '../server'

afterEach(() => {
  mcpMode.enabled = false
})

describe('createMcpServer', () => {
  /**
   * The ONLY test that proves `mcpMode.enabled` is ever SET. Every other MCP test in
   * this repo stubs the flag and then asserts a guard behaves — which tests the guard
   * GIVEN the flag, and would stay green if the one assignment were deleted or
   * misplaced, leaving the MCP hole exactly as open as before. Nothing here is stubbed.
   *
   * This is also why the assignment lives in `createMcpServer()` and not in
   * `entry/mcp.ts`: that module calls `startServer()` at module scope, so importing it
   * would start a real server over stdio and could never be asserted against.
   */
  it('marks the process as MCP mode before any transport is connected', async () => {
    expect(mcpMode.enabled).toBe(false)

    await createMcpServer()

    expect(mcpMode.enabled).toBe(true)
  })

  /**
   * The version advertised over `initialize` must be the real package version, not a
   * hardcoded literal. `McpServer` stores the `serverInfo` we pass on the underlying
   * low-level `server` (`_serverInfo`), which is what it echoes back to a client — so
   * we read it back from the actual constructed instance rather than an extracted
   * constant. A `'1.0.0'` regression here would misreport the CLI to every MCP client.
   */
  it('advertises the real package.json version, not a hardcoded literal', async () => {
    const server = await createMcpServer()

    const { version } = (server.server as unknown as { _serverInfo: { version: string } })._serverInfo

    expect(version).toBe(packageJson.version)
    expect(version).not.toBe('1.0.0')
  })
})
