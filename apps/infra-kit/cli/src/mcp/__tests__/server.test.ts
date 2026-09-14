import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'

import { mcpMode } from 'src/lib/mcp-mode'

import packageJson from '../../../package.json' with { type: 'json' }
import { RELEASE_CREATE_WORKFLOW_URI, SESSION_WORKFLOW_URI, SETUP_WORKFLOW_URI } from '../resources'
import { createMcpServer } from '../server'
import { WORKFLOW_BODIES } from '../workflow-bodies'

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
   * The pin for retiring the MCP prompt (docs/release-create-prompt-removal-plan.md): the plugin
   * command is the only human surface, so the server must neither ADVERTISE a prompt channel nor
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
   * Prettier owns the bytes of `resources/workflow/release-create.md`, so this asserts the
   * RENDERED shape — a line count and the substantive clauses — never that the file is
   * prettier-clean. A reflow that drops a section reddens the count; a rewrite that keeps the
   * count but loses the gate protocol reddens the substring checks.
   */
  it('renders a body that still carries the clauses an agent needs', () => {
    const body = WORKFLOW_BODIES['release-create']

    expect(body.split('\n')).toHaveLength(142)
    expect(body.endsWith('\n')).toBe(false)

    // The tool the procedure is for, named so an agent that read the resource can call it.
    expect(body).toContain('mcp__infra-kit__release-create')
    // The two-call gate, and the reading of `isError` that makes an agent bypass it.
    expect(body).toContain('confirmation_required')
    expect(body).toContain('confirmToken')
    expect(body).toContain('"confirm": true')

    // The `$ARGUMENTS` flags the plugin command's `argument-hint` advertises. They are conventions of
    // that command — neither the CLI nor the tool accepts them — so THIS body is the only place an
    // agent can learn what they mean. The hint promised them for a release cycle while nothing
    // defined them; the count above moved by exactly that repair, so these lines are what the new
    // lines have to be. `manifest.test.mjs`'s U17 binds the hint to these definitions from the other
    // side, but it is plain node and cannot see the bundled `WORKFLOW_BODIES` this asserts.
    expect(body).toContain('`--hotfix` → `type: "hotfix"`')
    expect(body).toContain('`--desc <text>` → `description`')
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

  /**
   * `setup`'s procedure over the wire. Resource-only, like every workflow: its human surface is the
   * `/infra-kit:setup` plugin command. The no-prompt-channel test above is what pins that decision
   * from the other side — registering a `setup` prompt reddens it and forces this comment to be
   * revisited rather than silently contradicted.
   */
  it('serves the setup procedure as a markdown resource at its URI', async () => {
    const { client, close } = await connectedClient()

    try {
      const result = await client.readResource({ uri: SETUP_WORKFLOW_URI })

      expect(result.contents).toHaveLength(1)
      expect(result.contents[0]!.uri).toBe(SETUP_WORKFLOW_URI)
      expect(result.contents[0]!.mimeType).toBe('text/markdown')
      expect(resourceText(result)).toBe(WORKFLOW_BODIES.setup)
    } finally {
      await close()
    }
  })

  /**
   * As above: prettier owns the bytes of `resources/workflow/setup.md`, so this asserts the RENDERED
   * shape — the line count and the substantive clauses — never that the source file is prettier-clean.
   *
   * Each clause below is one the plan requires the served body to carry, and each is the reason the
   * plugin command can be three lines: if the detail is not HERE, it is nowhere an agent can read it.
   */
  it('renders a setup body that still carries the clauses an agent needs', () => {
    const body = WORKFLOW_BODIES.setup

    expect(body.split('\n')).toHaveLength(163)
    expect(body.endsWith('\n')).toBe(false)

    // The tool the procedure is for, named so an agent that read the resource can call it — and the
    // read-path tool it must use instead when it only wants to look.
    expect(body).toContain('mcp__infra-kit__setup')
    expect(body).toContain('`doctor`')

    // The ordered procedure: the init half's writes first, then the dependency converge.
    expect(body).toContain('the init half')
    expect(body).toContain('`~/.zshrc`')
    expect(body).toContain('`.mcp.json`')
    expect(body).toContain('the dependency converge')
    expect(body).toContain('**brew, aws, gh, doppler, portless**')
    expect(body.indexOf('the init half')).toBeLessThan(body.indexOf('the dependency converge'))

    // What each flag narrows, in the `flag → tool field` form `manifest.test.mjs`'s U17 reads from the
    // other side. U17 is plain node and cannot see the bundled body this asserts.
    expect(body).toContain('`--tools <ids...>` → `tools: ["gh", "doppler"]`')
    expect(body).toContain('`--update [ids...]` → `mode: "update"`')
    expect(body).toContain('`--skip-tools` → `skipTools: true`')
    expect(body).toContain('usage error, not a precedence rule')

    // Refused recipes are PRINTED rather than run, and why — both refusing conjuncts, and both of the
    // two recipes that fail them.
    expect(body).toContain('needs-sudo')
    expect(body).toContain('fetches-network-script')
    expect(body).toContain('the Homebrew bootstrap')
    expect(body).toContain('the first AWS CLI install')
    expect(body).toContain('A refusal is not a failure')

    // The gate, and the `isError` reading that makes an agent bypass it.
    expect(body).toContain('confirmation_required')
    expect(body).toContain('confirmToken')
    expect(body).toContain('"confirm": true')
    expect(body).toContain('does not mean the call failed')

    // That `init` is gone AND what to run instead — both, because a body saying only that the command
    // was removed leaves an agent holding a repo's stale instruction with no next action.
    expect(body).toContain('There is no `init` command')
    expect(body).toContain('`infra-kit setup`')
    // Binary-qualified, and I-13 (`generated-instruction-spelling.test.ts`) is why: a bare `setup`
    // code span in this file resolves three ways in a consumer repo — `pnpm setup`, `pnpm run setup`
    // and `infra-kit setup` — and all three mutate something different.
    expect(body).toContain('`infra-kit setup --skip-tools`')
  })

  /**
   * `session`'s procedure over the wire. Resource-only for the same reason as `setup`, and pinned
   * from the other side by the no-prompt-channel test above.
   *
   * Unlike the other two, `session` is the procedure for no single tool — it composes `env-list`,
   * `env-load` and `env-clear`. So `resources/list` is asserted here too: an agent that cannot
   * DISCOVER the URI cannot read it, and the composing procedure is the one nothing else announces.
   */
  it('serves the session procedure as a markdown resource at its URI', async () => {
    const { client, close } = await connectedClient()

    try {
      const [{ resources }, result] = await Promise.all([
        client.listResources(),
        client.readResource({ uri: SESSION_WORKFLOW_URI }),
      ])

      expect(
        resources.map((r) => {
          return r.uri
        }),
      ).toContain(SESSION_WORKFLOW_URI)

      expect(result.contents).toHaveLength(1)
      expect(result.contents[0]!.uri).toBe(SESSION_WORKFLOW_URI)
      expect(result.contents[0]!.mimeType).toBe('text/markdown')
      expect(resourceText(result)).toBe(WORKFLOW_BODIES.session)
    } finally {
      await close()
    }
  })

  /**
   * As above: prettier owns the bytes, so this asserts the RENDERED shape.
   *
   * Every literal below is authored on a SINGLE line of `session.md` deliberately. `proseWrap` is
   * unset in the shared prettier config, so it defaults to `preserve` — prettier will not reflow that
   * file, but an author's own rewrap will, and a fragment spanning a line break fails `toContain`
   * even though the sentence still reads correctly. That is why these are fragments rather than
   * whole sentences: a whole sentence would redden on the first honest rewrap.
   *
   * What is enforced is that the body CARRIES the instruction. An agent's actual behaviour is
   * runtime and no test can pin it.
   */
  it('renders a session body that still carries the clauses an agent needs', () => {
    const body = WORKFLOW_BODIES.session

    expect(body.split('\n')).toHaveLength(109)
    expect(body.endsWith('\n')).toBe(false)

    // The three tools composed, named so an agent that read the resource can call them. `env-status`
    // is deliberately NOT among them: it is named in the body only as the thing not to verify with.
    expect(body).toContain('mcp__infra-kit__env-list')
    expect(body).toContain('mcp__infra-kit__env-load')
    // The flag definition, in the `flag → tool` form `manifest.test.mjs`'s U17 reads from the other
    // side once the plugin command exists. U17 is plain node and cannot see this bundled body.
    expect(body).toContain('`--clear` → `mcp__infra-kit__env-clear`')

    // The three properties of the shell round trip. Each one is a way the feature is judged broken
    // when the body omits it, and none of them is visible in any single tool's own description.
    expect(body).toContain('at its next prompt — after Claude Code exits or is backgrounded')
    expect(body).toContain('the terminal that launched Claude Code and no other')
    expect(body).toContain('writes into a directory nothing is watching and still returns success')

    // The only check a human can perform against that silent wrong-target. Two fragments of one
    // instruction: the second alone pins the rationale and would stay green while the instruction it
    // guards disappeared.
    expect(body).toContain('report the session id from the returned filePath')
    expect(body).toContain('compare it with INFRA_KIT_SESSION at their own prompt')

    // The Bash lie, both halves — that sourcing changes nothing, and the reason it changes nothing.
    expect(body).toContain('Bash')
    expect(body).toContain('does not persist shell state between calls')

    // The loud failure and its remediation, which is a setup run rather than a retry.
    expect(body).toContain('INFRA_KIT_SESSION is not set')
    expect(body).toContain('infra-kit setup --skip-tools')
    // Where an authoritative reading actually comes from, since `env-status` over MCP is not one.
    expect(body).toContain('typed in the terminal, not over MCP')

    // What `env-list` is and is not, so an absent name is still tried and an empty list is not
    // reported as breakage.
    expect(body).toContain('not a live Doppler enumeration')
    expect(body).toContain('an empty list is a legitimate result')

    // The gate, and the `isError` reading that makes an agent bypass it — plus the fact that the
    // OTHER tool has no gate, so nobody waits for a prompt that never arrives.
    expect(body).toContain('confirmation_required')
    expect(body).toContain('confirmToken')
    expect(body).toContain('"confirm": true')
    expect(body).toContain('`env-load` is not gated')

    // The same-second tie, and the symptom to look for: the shell's load gate wins, so what appears
    // after a clear is a LOAD notice, not a missing clear notice.
    expect(body).toContain('in the same wall-clock second')
    expect(body).toContain('infra-kit: auto-loaded vars for')

    // The body's only tether to the provider contract, which lives in the doc rather than here so an
    // agent spends its attention on the failure modes instead of on design narration.
    expect(body).toContain('docs/session-context-orchestrator.md')
  })
})
