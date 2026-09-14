import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'

import { mcpMode } from 'src/lib/mcp-mode'

import packageJson from '../../../package.json' with { type: 'json' }
import { SESSION_WORKFLOW_URI } from '../resources'
import { createMcpServer } from '../server'

afterEach(() => {
  mcpMode.enabled = false
})

/**
 * A real client on the other end of a real (in-memory) transport, so `resources/read` and the
 * refused `prompts/get` below go through the SDK's own request path — capability handshake
 * included.
 *
 * Reaching into the server's registration maps instead would assert what was registered and
 * prove nothing about what a client can actually FETCH, or be refused, over the wire.
 */
const connectedClient = async (): Promise<{ client: Client; close: () => Promise<void> }> => {
  const server = await createMcpServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'server-test', version: '0.0.0' })

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/**
 * The text of the single content a markdown resource returns. `ReadResourceResult` unions text and
 * blob contents, so a blob body fails here loudly rather than reading as `undefined === undefined`.
 */
const resourceText = (result: { contents: unknown[] }): string => {
  const first = result.contents[0] as { text?: unknown }

  expect(typeof first.text).toBe('string')

  return first.text as string
}

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

describe('the procedures, over the wire', () => {
  /**
   * The pin for retiring the MCP prompt (docs/release-create-prompt-removal-plan.md): the plugin
   * skill is the only human surface, so the server must neither ADVERTISE a prompt channel nor
   * ANSWER on it. The handshake half is what stops the host from listing prompts at all; the handler
   * half is what makes an empty `prompts: {}` capability — the vestigial slot that produced the
   * duplicate `/` row — a wire-visible regression rather than a shape the SDK quietly accepts.
   *
   * `listPrompts()` is deliberately NOT used: on a non-strict client it does not throw but logs and
   * resolves `{ prompts: [] }`, which is byte-identical to what the rejected keep-empty-capability
   * design returns — so it could not tell the chosen design from the rejected one. `getPrompt`
   * reaches the wire (the client-side capability gate is strict-mode only, and `connectedClient()`
   * enables no strict mode), where a server with no handler answers `Method not found` (-32601).
   */
  it('advertises no prompt channel and serves no prompt handler', async () => {
    const { client, close } = await connectedClient()

    try {
      expect(client.getServerCapabilities()?.prompts).toBeUndefined()
      await expect(client.getPrompt({ name: 'release-create' })).rejects.toMatchObject({ code: -32601 })
    } finally {
      await close()
    }
  })

  /**
   * The procedures themselves left the server for the plugin's skills (docs/session-env-picker-plan.md
   * §3.4). What survives, for ONE release, is a deprecation stub at the `session` URI: a consumer whose
   * plugin still carries the old `/infra-kit:session` command reads that URI FIRST, and the stub keeps it
   * on the form path instead of the 404 fallback. `resources/list` is asserted alongside the read
   * because that old command discovers the URI before fetching it.
   *
   * The other two URIs are gone outright — their commands' fallbacks call the tool directly — so a
   * read is refused, not answered with a body that would be stale the moment it was written.
   */
  it('serves only the session deprecation stub among the workflow URIs', async () => {
    const { client, close } = await connectedClient()

    try {
      const [{ resources }, result] = await Promise.all([
        client.listResources(),
        client.readResource({ uri: SESSION_WORKFLOW_URI }),
      ])

      const workflowUris = resources
        .map((r) => {
          return r.uri
        })
        .filter((uri) => {
          return uri.startsWith('infra-kit://workflow/')
        })

      expect(workflowUris).toEqual([SESSION_WORKFLOW_URI])

      expect(result.contents).toHaveLength(1)
      expect(result.contents[0]!.uri).toBe(SESSION_WORKFLOW_URI)
      expect(result.contents[0]!.mimeType).toBe('text/markdown')

      const body = resourceText(result)

      expect(body.split('\n')).toHaveLength(3)
      expect(body).toContain('/infra-kit:session')
      expect(body).toContain('without `config`')

      for (const retired of ['infra-kit://workflow/release-create', 'infra-kit://workflow/setup']) {
        await expect(client.readResource({ uri: retired })).rejects.toThrow()
      }
    } finally {
      await close()
    }
  })
})
