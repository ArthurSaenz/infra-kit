import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'

import { mcpMode } from 'src/lib/mcp-mode'

import packageJson from '../../../package.json' with { type: 'json' }
import { RELEASE_CREATE_WORKFLOW_URI } from '../resources'
import { createMcpServer } from '../server'
import { WORKFLOW_BODIES } from '../workflow-bodies'

afterEach(() => {
  mcpMode.enabled = false
})

/**
 * A real client on the other end of a real (in-memory) transport, so `prompts/get`,
 * `prompts/list` and `resources/read` go through the SDK's own request path — argument
 * validation included.
 *
 * Reaching into `_registeredPrompts` instead would assert what was registered and prove nothing
 * about whether it can be FETCHED, which is the entire point of the omitted-`arguments` case
 * below: a prompt carrying a bare `z.object({…})` argsSchema registers fine and throws on the
 * wire.
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

/** The text of the single message a workflow prompt returns. */
const promptText = (result: { messages: { content: unknown }[] }): string => {
  return (result.messages[0]!.content as { type: string; text: string }).text
}

/**
 * The text of the single content a workflow resource returns. `ReadResourceResult` unions text and
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

describe('the release-create procedure, over the wire', () => {
  /**
   * The AC the `argsSchema`-omitted decision exists for. Registering the prompt with a bare
   * `z.object({version: z.string()})` makes THIS call throw — every other assertion in this file
   * (name, bytes, count) passes against a prompt that cannot be fetched at all, because none of
   * them fetches it.
   */
  it('serves prompts/get for release-create with `arguments` omitted entirely', async () => {
    const { client, close } = await connectedClient()

    try {
      const result = await client.getPrompt({ name: 'release-create' })

      expect(promptText(result)).toBe(WORKFLOW_BODIES['release-create'])
    } finally {
      await close()
    }
  })

  /** An argsSchema-free prompt must IGNORE a stray `arguments`, not reject the request. */
  it('serves prompts/get for release-create when a stray `arguments` object is sent', async () => {
    const { client, close } = await connectedClient()

    try {
      const result = await client.getPrompt({ name: 'release-create', arguments: { version: '1.64.0' } })

      expect(promptText(result)).toBe(WORKFLOW_BODIES['release-create'])
    } finally {
      await close()
    }
  })

  /**
   * Pins §2.6's recorded asymmetry as an assertion rather than a paragraph: the prompt takes no
   * arguments, so a human picking it from the `/` menu gets the procedure and types the version in
   * chat. Adding an argsSchema later must redden this and force a revisit.
   */
  it('lists exactly one prompt, and it declares no arguments', async () => {
    const { client, close } = await connectedClient()

    try {
      const { prompts } = await client.listPrompts()

      expect(
        prompts.map((p) => {
          return p.name
        }),
      ).toEqual(['release-create'])
      expect(prompts[0]!.arguments ?? []).toEqual([])
    } finally {
      await close()
    }
  })

  it('serves the same procedure as a markdown resource at its URI', async () => {
    const { client, close } = await connectedClient()

    try {
      const result = await client.readResource({ uri: RELEASE_CREATE_WORKFLOW_URI })

      expect(result.contents).toHaveLength(1)
      expect(result.contents[0]!.uri).toBe(RELEASE_CREATE_WORKFLOW_URI)
      expect(result.contents[0]!.mimeType).toBe('text/markdown')
      expect(resourceText(result)).toBe(WORKFLOW_BODIES['release-create'])
    } finally {
      await close()
    }
  })

  /**
   * The two channels exist because an agent can read a resource but cannot fetch a prompt. They
   * are registered from ONE constant so the prose cannot drift; this compares what actually came
   * back over each channel, so hand-typing a second literal into either registration reddens it.
   */
  it('serves byte-identical text through the prompt and the resource', async () => {
    const { client, close } = await connectedClient()

    try {
      const [prompt, resource] = await Promise.all([
        client.getPrompt({ name: 'release-create' }),
        client.readResource({ uri: RELEASE_CREATE_WORKFLOW_URI }),
      ])

      expect(promptText(prompt)).toBe(resourceText(resource))
    } finally {
      await close()
    }
  })

  /**
   * Prettier owns the bytes of `resources/workflow/release-create.md`, so this asserts the
   * RENDERED shape — a line count and the substantive clauses — never that the file is
   * prettier-clean. A reflow that drops a section reddens the count; a rewrite that keeps the
   * count but loses the gate protocol reddens the substring checks.
   */
  it('renders a body that still carries the clauses an agent needs', () => {
    const body = WORKFLOW_BODIES['release-create']

    expect(body.split('\n')).toHaveLength(118)
    expect(body.endsWith('\n')).toBe(false)

    // The tool the procedure is for, named so an agent that read the resource can call it.
    expect(body).toContain('mcp__infra-kit__release-create')
    // The two-call gate, and the reading of `isError` that makes an agent bypass it.
    expect(body).toContain('confirmation_required')
    expect(body).toContain('confirmToken')
    expect(body).toContain('"confirm": true')
    expect(body).toContain('does not mean the call failed')
    expect(body).toContain('Bash')
    // The argument rules.
    expect(body).toContain('mutually exclusive')
    expect(body).toContain('"next"')
    expect(body).toContain('all entries must share the same `type`')
    // The preconditions.
    expect(body).toContain('linked worktree')
    expect(body).toContain('clean working tree')
  })
})
