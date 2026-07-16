import { afterEach, describe, expect, it } from 'vitest'

import { mcpMode } from 'src/lib/mcp-mode'

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
})
