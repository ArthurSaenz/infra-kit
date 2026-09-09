import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import { initializePrompts } from '..'
import { getExposedMcpTools } from '../../../lib/command-catalog'

/** Reach into the SDK's private prompt registry to assert what was registered. */
interface RegisteredPrompt {
  argsSchema?: unknown
}

const registeredOf = (server: McpServer): Record<string, RegisteredPrompt> => {
  return (server as unknown as { _registeredPrompts: Record<string, RegisteredPrompt> })._registeredPrompts
}

const newServer = (): McpServer => {
  return new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { prompts: {} } })
}

describe('initializePrompts', () => {
  it('registers exactly the release-create prompt (it is no longer a no-op)', async () => {
    const server = newServer()

    await initializePrompts(server)

    expect(Object.keys(registeredOf(server))).toEqual(['release-create'])
  })

  /**
   * The registration-level half of the `argsSchema`-omitted decision. The wire-level half — a real
   * `prompts/get` with `arguments` omitted — is in `src/mcp/__tests__/server.test.ts`, and it is
   * the one that catches the hazard; this row is what makes the reason visible at the call site.
   */
  it('declares no argsSchema at all, so an omitted `arguments` cannot throw', async () => {
    const server = newServer()

    await initializePrompts(server)

    expect(registeredOf(server)['release-create']!.argsSchema).toBeUndefined()
  })

  /**
   * The naming partition (§4.2's clause: a prompt name MAY equal a tool name, and must never equal
   * a tool it does not primarily run). Asserting equality of BOTH halves means a rename reddens
   * twice — the tool-named half loses its member and the non-tool half gains one. Asserting only a
   * count, or only that `release-create` is a tool name, would survive that rename.
   */
  it('partitions its prompt names against the exposed tool names', async () => {
    const server = newServer()

    await initializePrompts(server)

    const names = Object.keys(registeredOf(server))
    const exposed = new Set(
      getExposedMcpTools().map((tool) => {
        return tool.name
      }),
    )

    expect(
      names.filter((name) => {
        return exposed.has(name)
      }),
    ).toEqual(['release-create'])
    expect(
      names.filter((name) => {
        return !exposed.has(name)
      }),
    ).toEqual([])
  })
})

// Deliberately NOT asserted here: that the prompt returns `WORKFLOW_BODIES['release-create']`.
// Reading the body back needs the SDK's private `handler` field, and `src/mcp/__tests__/server.test.ts`
// already asserts it over a real transport — against the resource's bytes as well as the constant's,
// which is the assertion that makes the two channels one source.
