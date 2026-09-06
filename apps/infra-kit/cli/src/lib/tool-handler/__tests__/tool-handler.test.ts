import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureUserProjectConfig, seedUserProjectConfig } from 'src/lib/config-bootstrap'
import type { ToolsExecutionResult } from 'src/types'

import { createConfirmCodec } from '../confirm-token'
import type { ConfirmCodec } from '../confirm-token'
import { createToolHandler } from '../tool-handler'

// The ENTIRE config-bootstrap module is faked: the real seed must never run here, because it writes
// to ~/.infra-kit/projects/<repo>/ and no test may touch the developer's real $HOME. (The
// `INFRA_KIT_NO_SEED=1` tripwire in vitest.setup.ts is the second line of defence, not the first.)
//
// `ensureUserProjectConfig` is stubbed with a fake that MIRRORS the real module's two load-bearing
// contract points — a once-per-process guard and a never-throw body — so this file can pin the
// BOUNDARY behaviour (does the MCP wrapper call the guarded entry point, before the handler, on
// every tool call?) while config-bootstrap.test.ts owns the guard's own coverage. The guard flag
// lives out here so `beforeEach` can reset it; the real module resets via resetUserProjectSeedGuard.
//
// `seedUserProjectConfig` (the UNGATED primitive) is exported as a bare spy purely so a test can
// assert the boundary never reaches for it — that swap would re-seed on every single tool call.
let seeded = false
let seedRuns = 0
let seedShouldFail = false
let seedShouldReject = false
let order: string[] = []

vi.mock('src/lib/config-bootstrap', () => {
  return {
    ensureUserProjectConfig: vi.fn(async () => {
      order.push('seed')

      if (seeded) {
        return
      }

      seeded = true

      if (seedShouldReject) {
        // Contract violation, simulated on purpose — see the defense-in-depth test below.
        throw new Error('bootstrap contract broken')
      }

      try {
        if (seedShouldFail) {
          throw new Error('EACCES: read-only home')
        }

        seedRuns += 1
      } catch {
        // The real ensureUserProjectConfig swallows every seed failure (logger.debug only).
      }
    }),
    seedUserProjectConfig: vi.fn(),
  }
})

const payload: ToolsExecutionResult = {
  content: [{ type: 'text', text: 'ok' }],
  structuredContent: { ran: true },
}

/** The token a round-1 gate hands out; throws if the gate carried none, so a missing token fails loudly. */
const gateToken = (gate: ToolsExecutionResult): string => {
  const { confirmToken } = gate.structuredContent as { confirmToken?: unknown }

  if (typeof confirmToken !== 'string') throw new Error('gate carried no confirmToken')

  return confirmToken
}

const refusalOf = (result: ToolsExecutionResult): { status?: unknown; reason?: unknown } => {
  return result.structuredContent as { status?: unknown; reason?: unknown }
}

beforeEach(() => {
  seeded = false
  seedRuns = 0
  seedShouldFail = false
  seedShouldReject = false
  order = []
  vi.clearAllMocks()
})

describe('createToolHandler', () => {
  it('awaits the user-project seed before invoking the handler, on every tool call', async () => {
    const handler = vi.fn(async () => {
      order.push('handler')

      return payload
    })
    const tool = createToolHandler({ toolName: 'version', handler })

    await tool({})
    await tool({})

    expect(order).toEqual(['seed', 'handler', 'seed', 'handler'])
    expect(ensureUserProjectConfig).toHaveBeenCalledTimes(2)
    // The GATED entry point is what the boundary calls — never the ungated primitive, which would
    // re-write on every tool call of this long-lived server process.
    expect(seedUserProjectConfig).not.toHaveBeenCalled()
  })

  it('performs the seed work only once across two tool calls (once-per-process guard)', async () => {
    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({ toolName: 'version', handler })

    await tool({})
    await tool({})

    expect(seedRuns).toBe(1)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('leaves the handler payload and its auto-confirm untouched', async () => {
    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({ toolName: 'worktrees-list', handler })

    const result = await tool({ branch: 'main' })

    expect(result).toBe(payload)
    expect(handler).toHaveBeenCalledWith({ branch: 'main', confirmedCommand: true })
  })

  it('does not fail the tool call when the seed itself fails', async () => {
    seedShouldFail = true

    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({ toolName: 'version', handler })

    await expect(tool({})).resolves.toBe(payload)
    expect(seedRuns).toBe(0)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('surfaces a broken never-throw contract as an ordinary tool error, not an unhandled rejection', async () => {
    seedShouldReject = true

    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({ toolName: 'version', handler })

    // Defense-in-depth: the await lives INSIDE createToolHandler's try, so even if the bootstrap's
    // never-throw contract regressed, the long-lived MCP server would see a normal tool error rather
    // than an unhandled rejection that takes the process down.
    await expect(tool({})).rejects.toThrow('bootstrap contract broken')
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('createToolHandler — destructive-op confirm gate', () => {
  it('returns a gate response and does NOT run the handler when a flagged tool is called without confirm', async () => {
    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({ toolName: 'env-clear', handler, requiresHumanConfirm: true })

    const result = await tool({ version: '1.2.5' })

    // The handler must never have run — nothing was mutated.
    expect(handler).not.toHaveBeenCalled()
    // The gate response names the tool, echoes the resolved args (minus confirm), and is marked
    // isError so the MCP SDK does not validate it against the tool's outputSchema.
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      status: 'confirmation_required',
      tool: 'env-clear',
      resolvedArgs: { version: '1.2.5' },
    })
    expect(result.content[0]?.text).toContain('confirm')
  })

  it('runs the handler exactly once, with confirmedCommand:true, on a round 2 that carries the round-1 token', async () => {
    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({ toolName: 'env-clear', handler, requiresHumanConfirm: true })

    const gate = await tool({ version: '1.2.5' })
    const confirmToken = gateToken(gate)

    const result = await tool({ confirm: true, confirmToken, version: '1.2.5' })

    expect(result).toBe(payload)
    // The gate is orthogonal to confirmedCommand: the real call STILL injects confirmedCommand:true
    // (the prompt-skip / behavior discriminator), and passes confirm + confirmToken through untouched.
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ confirm: true, confirmToken, version: '1.2.5', confirmedCommand: true })
  })

  it('accepts a round 2 whose keys arrive in a different order (canonical, not textual, binding)', async () => {
    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({ toolName: 'env-clear', handler, requiresHumanConfirm: true })

    const gate = await tool({ a: 1, nested: { y: [1, 2], x: 'z' } })

    await expect(
      tool({ nested: { x: 'z', y: [1, 2] }, confirmToken: gateToken(gate), a: 1, confirm: true }),
    ).resolves.toBe(payload)
  })

  it('leaves a non-flagged tool completely unaffected (runs on the first call, no gate)', async () => {
    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({ toolName: 'worktrees-list', handler })

    const result = await tool({ branch: 'main' })

    expect(result).toBe(payload)
    expect(handler).toHaveBeenCalledWith({ branch: 'main', confirmedCommand: true })
  })

  it('does not gate a flagged tool merely because confirm is falsy-but-present (confirm:false gates)', async () => {
    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({ toolName: 'gh-merge-dev', handler, requiresHumanConfirm: true })

    const result = await tool({ all: true, confirm: false })

    // confirm must be strictly true to execute; false still returns the gate (fail-closed).
    expect(handler).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })
})

/**
 * Round 2 is bound to round 1 by a signed token over the tool name and the canonical arguments.
 * Every refusal below is a terminal `confirmation_refused` — never a second gate, because a
 * token-less round 2 that received a fresh gate could re-call with substituted arguments forever.
 */
describe('createToolHandler — confirm token binding (round-2 refusals)', () => {
  const gatedTool = (toolName: string, options: { confirmCodec?: ConfirmCodec } = {}) => {
    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({ toolName, handler, requiresHumanConfirm: true, ...options })

    return { tool, handler }
  }

  const expectRefusal = (result: ToolsExecutionResult, reason: string | string[]): void => {
    expect(result.isError).toBe(true)
    expect(refusalOf(result).status).toBe('confirmation_refused')
    expect(Array.isArray(reason) ? reason : [reason]).toContain(refusalOf(result).reason)
  }

  it('hands out a confirmToken on round 1', async () => {
    const { tool } = gatedTool('env-clear')

    expect(gateToken(await tool({ version: '1.2.5' }))).toMatch(/^v1\./)
  })

  it('refuses a round 2 that carries no token — absence is a refusal, not a fresh gate', async () => {
    const { tool, handler } = gatedTool('env-clear')

    const result = await tool({ confirm: true, version: '1.2.5' })

    expectRefusal(result, 'absent')
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses a round 2 whose arguments differ from the ones round 1 was called with', async () => {
    const { tool, handler } = gatedTool('env-load')

    const confirmToken = gateToken(await tool({ config: 'dev' }))
    const result = await tool({ config: 'prod', confirm: true, confirmToken })

    expectRefusal(result, 'mismatch')
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses a tampered token', async () => {
    const { tool, handler } = gatedTool('env-clear')

    const confirmToken = gateToken(await tool({ version: '1.2.5' }))
    // Flip a character in the MIDDLE of the token. The last base64url character of a 32-byte MAC
    // carries two padding bits that decode to nothing, so `A` and `B` there yield identical bytes
    // and the "tampered" token verified about one run in sixteen.
    const at = Math.floor(confirmToken.length / 2)
    const replacement = confirmToken[at] === 'A' ? 'B' : 'A'
    const flipped = `${confirmToken.slice(0, at)}${replacement}${confirmToken.slice(at + 1)}`
    const result = await tool({ confirm: true, confirmToken: flipped, version: '1.2.5' })

    expectRefusal(result, ['mac', 'malformed'])
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses garbage where a token should be', async () => {
    const { tool, handler } = gatedTool('env-clear')

    const result = await tool({ confirm: true, confirmToken: 'not-a-token', version: '1.2.5' })

    expectRefusal(result, 'malformed')
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses an expired token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      const { tool, handler } = gatedTool('env-clear', { confirmCodec: createConfirmCodec({ ttlSeconds: 1 }) })

      const confirmToken = gateToken(await tool({ version: '1.2.5' }))

      vi.setSystemTime(Date.now() + 5_000)

      const result = await tool({ confirm: true, confirmToken, version: '1.2.5' })

      expectRefusal(result, 'expired')
      expect(handler).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a token minted for a different tool (bound by tool name)', async () => {
    const shared = createConfirmCodec()
    const envClear = gatedTool('env-clear', { confirmCodec: shared })
    const mergeDev = gatedTool('gh-merge-dev', { confirmCodec: shared })

    const confirmToken = gateToken(await envClear.tool({}))
    const result = await mergeDev.tool({ confirm: true, confirmToken })

    expectRefusal(result, 'bind')
    expect(mergeDev.handler).not.toHaveBeenCalled()
  })

  it('refuses a token minted under a different key (another server process)', async () => {
    const minter = gatedTool('env-clear', { confirmCodec: createConfirmCodec() })
    const verifier = gatedTool('env-clear', { confirmCodec: createConfirmCodec() })

    const confirmToken = gateToken(await minter.tool({ version: '1.2.5' }))
    const result = await verifier.tool({ confirm: true, confirmToken, version: '1.2.5' })

    expectRefusal(result, 'mac')
    expect(verifier.handler).not.toHaveBeenCalled()
  })
})
