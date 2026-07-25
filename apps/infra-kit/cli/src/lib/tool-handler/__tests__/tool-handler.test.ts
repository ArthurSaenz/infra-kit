import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureUserProjectConfig, seedUserProjectConfig } from 'src/lib/config-bootstrap'
import type { ToolsExecutionResult } from 'src/types'

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

  it('runs the handler with confirmedCommand:true when a flagged tool is called WITH confirm:true', async () => {
    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({ toolName: 'env-clear', handler, requiresHumanConfirm: true })

    const result = await tool({ confirm: true, version: '1.2.5' })

    expect(result).toBe(payload)
    // The gate is orthogonal to confirmedCommand: the real call STILL injects confirmedCommand:true
    // (the prompt-skip / behavior discriminator), and passes confirm through untouched.
    expect(handler).toHaveBeenCalledWith({ confirm: true, version: '1.2.5', confirmedCommand: true })
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
