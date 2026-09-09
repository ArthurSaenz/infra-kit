import type { ClientCapabilities, InputRequiredResult } from '@modelcontextprotocol/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ensureUserProjectConfig, seedUserProjectConfig } from 'src/lib/config-bootstrap'
import { logger } from 'src/lib/logger'
import type { ArgumentFormProvider, ToolsExecutionResult } from 'src/types'

import { createConfirmCodec } from '../confirm-token'
import type { ConfirmCodec } from '../confirm-token'
import { createToolHandler, resolveGateState } from '../tool-handler'
import type { ToolCallContext } from '../tool-handler'

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

/**
 * Narrows a handler result to a TOOL result, throwing if the SDK's `InputRequiredResult` — "I need
 * input from the human before I can run" — came back where a gate or a payload was expected.
 *
 * The handler's return type is the union of the two, so every case below has to say which one it
 * expects. It says so with this check rather than a cast: nothing in this file may reach a form
 * (that needs a `formProvider`, which none of these handlers is built with), so an `InputRequiredResult`
 * arriving here is a real defect, and it must fail in the case that receives it instead of being
 * typed away at the boundary.
 */
const asToolResult = (result: ToolsExecutionResult | InputRequiredResult): ToolsExecutionResult => {
  if (!Array.isArray((result as ToolsExecutionResult).content)) {
    throw new TypeError(`expected a tool result, got resultType=${String((result as InputRequiredResult).resultType)}`)
  }

  return result as ToolsExecutionResult
}

/** The token a round-1 gate hands out; throws if the gate carried none, so a missing token fails loudly. */
const gateToken = (gate: ToolsExecutionResult | InputRequiredResult): string => {
  const { confirmToken } = asToolResult(gate).structuredContent as { confirmToken?: unknown }

  if (typeof confirmToken !== 'string') throw new Error('gate carried no confirmToken')

  return confirmToken
}

const refusalOf = (result: ToolsExecutionResult | InputRequiredResult): { status?: unknown; reason?: unknown } => {
  return asToolResult(result).structuredContent as { status?: unknown; reason?: unknown }
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
    expect(asToolResult(result).content[0]?.text).toContain('confirm')
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

  const expectRefusal = (result: ToolsExecutionResult | InputRequiredResult, reason: string | string[]): void => {
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

/**
 * The argument form: candidates 1 (`form`) and 2 (`declined`), the capability probe, the deadline
 * race, the validated re-entry and the non-narrowing check.
 *
 * Every provider below is a FAKE, and deliberately so: no tool in the tree carries a `formProvider`
 * yet, so candidate 1 is unreachable in production and injected fakes are the only thing that
 * exercises it at all. A fake is also the only way to drive a MALICIOUS provider, which is what
 * the non-narrowing check exists for.
 */
describe('createToolHandler — argument form', () => {
  // The SDK normalizes a bare `{elicitation:{}}` to `{elicitation:{form:{}}}` (`ElicitationCapabilitySchema`
  // is a `z.preprocess`), so `caps?.elicitation` and `caps?.elicitation?.form` agree on every fixture
  // EXCEPT this url-only one. It is the single fixture that can tell the two spellings apart.
  const FORM_CAPABLE = { elicitation: { form: {} } } as unknown as ClientCapabilities
  const URL_ONLY = { elicitation: { url: {} } } as unknown as ClientCapabilities

  /** The form's own schema. Flat primitives only — the wire shape `elicit()` can express. */
  const formSchema = () => {
    return z.object({
      version: z.string().describe('The version to cut'),
      type: z.enum(['regular', 'hotfix']).optional().describe('Release type'),
    })
  }

  /**
   * A well-behaved provider: it MERGES form content over the round-1 entry field-by-field, and only
   * where the human supplied a value. Overridable one member at a time so each case below states
   * exactly the one thing it is about.
   */
  const makeProvider = (overrides: Partial<ArgumentFormProvider> = {}): ArgumentFormProvider => {
    return {
      message: 'Which version should be cut?',
      isFormable: () => {
        return true
      },
      buildRequestedSchema: async () => {
        return formSchema()
      },
      toArgs: (content, params) => {
        const round1 = (params ?? {}) as { releases?: Record<string, unknown>[] }
        const base = round1.releases?.[0] ?? {}
        const supplied = Object.fromEntries(
          Object.entries(content).filter(([, value]) => {
            return value !== undefined
          }),
        )

        return { ...round1, releases: [{ ...base, ...supplied }] }
      },
      ...overrides,
    }
  }

  const formTool = (
    options: {
      provider?: ArgumentFormProvider
      capabilities?: ClientCapabilities
      requiresHumanConfirm?: boolean
      formDeadlineMs?: number
    } = {},
  ) => {
    const handler = vi.fn(async () => {
      return payload
    })
    const tool = createToolHandler({
      toolName: 'release-create',
      handler,
      requiresHumanConfirm: options.requiresHumanConfirm ?? true,
      formProvider: options.provider,
      getClientCapabilities: () => {
        return options.capabilities
      },
      // Milliseconds, not the 3 s production budget: the deadline lane must assert a BOUND, and a
      // real-time race is what lets it fail as an assertion instead of hanging until vitest's timeout.
      formDeadlineMs: options.formDeadlineMs ?? 50,
    })

    return { tool, handler }
  }

  /** The `ctx` a client's retry arrives with. `undefined` content means the SDK dropped the entry. */
  const reentry = (response: unknown, dropped?: string[]): ToolCallContext => {
    return {
      mcpReq: {
        inputResponses: response === undefined ? {} : { args: response },
        droppedInputResponseKeys: dropped,
      },
    }
  }

  /** A retry carrying an accepted form, through the JSON round trip the wire actually performs. */
  const accepted = (content: Record<string, unknown>): ToolCallContext => {
    return reentry(JSON.parse(JSON.stringify({ action: 'accept', content })))
  }

  const isForm = (result: ToolsExecutionResult | InputRequiredResult): boolean => {
    return !Array.isArray((result as ToolsExecutionResult).content)
  }

  interface WireForm {
    resultType: string
    inputRequests: {
      args: { method: string; params: { message: string; requestedSchema: { properties: Record<string, unknown> } } }
    }
  }

  /** The mirror of `asToolResult`: narrows to the FORM, throwing if a tool result arrived instead. */
  const asForm = (result: ToolsExecutionResult | InputRequiredResult): WireForm => {
    if (!isForm(result)) {
      throw new TypeError(
        `expected an InputRequiredResult, got status=${String(
          (asToolResult(result).structuredContent as { status?: unknown }).status,
        )}`,
      )
    }

    return result as unknown as WireForm
  }

  const gateOf = (result: ToolsExecutionResult | InputRequiredResult): Record<string, unknown> => {
    return asToolResult(result).structuredContent as Record<string, unknown>
  }

  it('f0: an UNGATED tool runs on call 1, provider and form-capable client notwithstanding', async () => {
    const { tool, handler } = formTool({
      requiresHumanConfirm: false,
      provider: makeProvider(),
      capabilities: FORM_CAPABLE,
    })

    const result = await tool({ releases: [{ version: 'next' }] })

    expect(result).toBe(payload)
    expect(isForm(result)).toBe(false)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('f1: a gated tool with a provider and a form-capable client returns a form carrying NO confirm field', async () => {
    const { tool, handler } = formTool({ provider: makeProvider(), capabilities: FORM_CAPABLE })

    const form = asForm(await tool({ releases: [{ version: 'next' }] }))

    expect(form.resultType).toBe('input_required')
    expect(form.inputRequests.args.method).toBe('elicitation/create')
    expect(form.inputRequests.args.params.message).toBe('Which version should be cut?')
    // The gate's own key must never be a form field: a human who could tick `confirm` in the form
    // would be approving and answering in one action, which is the whole point of the second round.
    expect(Object.keys(form.inputRequests.args.params.requestedSchema.properties)).toEqual(['version', 'type'])
    expect(Object.keys(form.inputRequests.args.params.requestedSchema.properties)).not.toContain('confirm')
    expect(handler).not.toHaveBeenCalled()
  })

  it('f2: a url-only client is NOT form-capable — it gets the gate', async () => {
    const { tool, handler } = formTool({ provider: makeProvider(), capabilities: URL_ONLY })

    const result = await tool({ releases: [{ version: 'next' }] })

    expect(isForm(result)).toBe(false)
    expect(gateOf(result)).toMatchObject({
      status: 'confirmation_required',
      resolvedArgs: { releases: [{ version: 'next' }] },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('f2: a client that declares no capabilities at all gets the gate', async () => {
    const { tool, handler } = formTool({ provider: makeProvider(), capabilities: undefined })

    expect(isForm(await tool({ releases: [] }))).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([
    ['a decline', { action: 'decline' }, undefined, 'decline'],
    ['a cancel', { action: 'cancel' }, undefined, 'cancel'],
    ['a non-elicitation response kind', { roots: [] }, undefined, 'missing'],
    ['an entry the SDK dropped', undefined, ['args'], 'missing'],
  ])(
    'f3: %s is terminal — exactly ONE form across the exchange, and never a second',
    async (_label, response, dropped, action) => {
      const { tool, handler } = formTool({ provider: makeProvider(), capabilities: FORM_CAPABLE })
      const round1 = { releases: [{ version: 'next' }] }

      const first = await tool(round1)
      const second = await tool(round1, reentry(response, dropped))

      expect(isForm(first)).toBe(true)
      expect(isForm(second)).toBe(false)
      expect(asToolResult(second).isError).toBe(true)
      expect(gateOf(second)).toMatchObject({ status: 'form_declined', tool: 'release-create', action })
      // The count, not just the second result: re-issuing the form on a decline is an infinite prompt
      // loop whose engine is the human's own "no".
      expect([first, second].filter(isForm)).toHaveLength(1)
      expect(handler).not.toHaveBeenCalled()
    },
  )

  it('f4: an accepted form gates on the COLLECTED values, with a token bound to them', async () => {
    const { tool, handler } = formTool({ provider: makeProvider(), capabilities: FORM_CAPABLE })
    const round1 = { releases: [{ version: 'next', type: 'regular' }] }
    const collected = { releases: [{ version: '1.63.1', type: 'regular' }] }

    await tool(round1)
    const gate = await tool(round1, accepted({ version: '1.63.1' }))

    expect(gateOf(gate)).toMatchObject({
      status: 'confirmation_required',
      resolvedArgs: collected,
      formDiscarded: false,
    })
    await expect(tool({ ...collected, confirm: true, confirmToken: gateToken(gate) })).resolves.toBe(payload)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('f5: a gated tool with NO provider gates on call 1, and emits zero forms', async () => {
    const { tool, handler } = formTool({ provider: undefined, capabilities: FORM_CAPABLE })

    const result = await tool({ releases: [{ version: 'next' }] })

    expect(isForm(result)).toBe(false)
    expect(gateOf(result)).toMatchObject({ status: 'confirmation_required' })
    // PM-D mitigation (a): the seven provider-less gated tools say so, rather than letting the
    // absence of a dialog read as "nothing is about to happen".
    expect(gateOf(result).message).toContain('does not prompt for its arguments')
    expect(handler).not.toHaveBeenCalled()
  })

  it('f5: `hasProvider` is a candidate-1 conjunct in its own right, not a consequence of `formable`', () => {
    // Driven against the predicate directly BECAUSE the end-to-end lane above cannot tell which of
    // the two guards held: `buildFormOrGate` narrows on the provider a second time, so deleting
    // `hasProvider` here leaves the observable outcome unchanged. This is the assertion the deletion
    // actually reddens — an empty form for the other seven gated tools (PM-A).
    expect(
      resolveGateState({
        gated: true,
        confirmed: false,
        responses: undefined,
        canForm: true,
        hasProvider: false,
        formable: true,
        accepted: false,
      }),
    ).toBe('gate')
  })

  it('f6: a provider whose schema build REJECTS falls to the gate, with no thrown error', async () => {
    const { tool, handler } = formTool({
      provider: makeProvider({
        buildRequestedSchema: async () => {
          throw new Error('git ls-remote exploded')
        },
      }),
      capabilities: FORM_CAPABLE,
    })

    const result = await tool({ releases: [] })

    expect(isForm(result)).toBe(false)
    expect(gateOf(result)).toMatchObject({ status: 'confirmation_required' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('f6: a provider that never resolves falls to the gate WITHIN the deadline', async () => {
    const { tool, handler } = formTool({
      provider: makeProvider({
        buildRequestedSchema: () => {
          return new Promise(() => {})
        },
      }),
      capabilities: FORM_CAPABLE,
      formDeadlineMs: 40,
    })

    let guardTimer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<string>((resolve) => {
      guardTimer = setTimeout(() => {
        resolve('OUTRAN_THE_TEST')
      }, 2_000)
    })
    const started = Date.now()
    const raced = await Promise.race([tool({ releases: [] }), guard])
    const elapsed = Date.now() - started

    clearTimeout(guardTimer)
    // Raced in the TEST too, so a missing deadline wrapper fails as an assertion rather than hanging
    // until the runner's own timeout — which reads as infrastructure flake, not as a defect.
    expect(raced).not.toBe('OUTRAN_THE_TEST')
    expect(elapsed).toBeLessThan(1_000)
    expect(gateOf(raced as ToolsExecutionResult)).toMatchObject({ status: 'confirmation_required' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('f6: a schema `elicit()` cannot express falls to the gate rather than throwing', async () => {
    const { tool, handler } = formTool({
      // Measured: a nested object property makes `inputRequired.elicit` throw a TypeError BEFORE
      // anything is sent — "only supports flat primitive properties".
      provider: makeProvider({
        buildRequestedSchema: async () => {
          return z.object({ nested: z.object({ a: z.string() }) })
        },
      }),
      capabilities: FORM_CAPABLE,
    })

    const result = await tool({ releases: [] })

    expect(isForm(result)).toBe(false)
    expect(gateOf(result)).toMatchObject({ status: 'confirmation_required' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('f7: a round 2 carrying no inputResponses reaches VERIFY, not the gate', async () => {
    const { tool, handler } = formTool({ provider: makeProvider(), capabilities: URL_ONLY })
    const args = { releases: [{ version: '1.2.3' }] }

    const gate = await tool(args)
    const result = await tool({ ...args, confirm: true, confirmToken: gateToken(gate) })

    expect(result).toBe(payload)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('f8: a multi-entry batch is NOT formable — all three entries reach the gate, and the token binds them', async () => {
    // `length > 1` AND at least one `next`: without the `next` a predicate weakened to
    // "absent/empty ∨ hasNextToken" stays false, the mutation is invisible, and the case is vacuous.
    // Position is irrelevant — `hasNextToken` is `.some(…)` — so `next` sits second on purpose.
    const batch = {
      releases: [
        { version: '1.64.0', type: 'regular' },
        { version: 'next', type: 'regular' },
        { version: '1.66.0', type: 'regular' },
      ],
    }
    const hasNextToken = (entries: { version?: unknown }[]): boolean => {
      return entries.some((entry) => {
        return entry.version === 'next'
      })
    }
    const isFormable = (params: unknown): boolean => {
      const releases = (params as { releases?: unknown }).releases

      if (releases === undefined) return true
      if (!Array.isArray(releases)) return false
      if (releases.length === 0) return true

      return releases.length === 1 && hasNextToken(releases as { version?: unknown }[])
    }
    const { tool, handler } = formTool({ provider: makeProvider({ isFormable }), capabilities: FORM_CAPABLE })

    const gate = await tool(batch)
    const confirmToken = gateToken(gate)

    expect(isForm(gate)).toBe(false)
    expect(gateOf(gate)).toMatchObject({ status: 'confirmation_required', resolvedArgs: batch })
    await expect(tool({ ...batch, confirm: true, confirmToken })).resolves.toBe(payload)

    const truncated = await tool({ releases: [batch.releases[1]], confirm: true, confirmToken })

    expect(refusalOf(truncated).reason).toBe('mismatch')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('f9: content that fails the schema is DISCARDED — the gate says so and carries the round-1 arguments', async () => {
    const { tool, handler } = formTool({ provider: makeProvider(), capabilities: FORM_CAPABLE })
    const round1 = { releases: [{ version: 'next', type: 'hotfix' }] }

    const gate = await tool(round1, accepted({ version: 42 }))

    expect(isForm(gate)).toBe(false)
    expect(gateOf(gate)).toMatchObject({ status: 'confirmation_required', resolvedArgs: round1, formDiscarded: true })
    // Prose AND a field: without both, the gate presents the AGENT's values for approval unlabelled,
    // in place of the ones the human just chose — a whole-selection substitution.
    expect(gateOf(gate).message).toContain('DISCARDED')
    await expect(tool({ ...round1, confirm: true, confirmToken: gateToken(gate) })).resolves.toBe(payload)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'throws',
      () => {
        throw new Error('toArgs exploded')
      },
    ],
    [
      'returns null',
      () => {
        return null
      },
    ],
  ])('f10: a toArgs that %s gates on the round-1 arguments — never a tool error', async (_label, toArgs) => {
    const { tool, handler } = formTool({ provider: makeProvider({ toArgs }), capabilities: FORM_CAPABLE })
    const round1 = { releases: [{ version: 'next', type: 'hotfix' }] }

    const gate = await tool(round1, accepted({ version: '1.63.1' }))

    expect(isForm(gate)).toBe(false)
    expect(gateOf(gate)).toMatchObject({ status: 'confirmation_required', resolvedArgs: round1, formDiscarded: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('f11: fields the human did not touch keep their round-1 values', async () => {
    const { tool, handler } = formTool({ provider: makeProvider(), capabilities: FORM_CAPABLE })
    const round1 = { releases: [{ version: 'next', type: 'hotfix', description: 'urgent auth patch' }] }
    const merged = { releases: [{ version: '1.63.1', type: 'hotfix', description: 'urgent auth patch' }] }

    const gate = await tool(round1, accepted({ version: '1.63.1' }))

    // `type` is the one that matters: a hotfix silently becoming `regular` cuts the release from
    // `dev` instead of `main`, and every mechanism downstream reports success.
    expect(gateOf(gate)).toMatchObject({ status: 'confirmation_required', resolvedArgs: merged })
    await expect(tool({ ...merged, confirm: true, confirmToken: gateToken(gate) })).resolves.toBe(payload)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('f11: a field the human DID supply wins — the merge is not "round 1 always wins"', async () => {
    const { tool } = formTool({ provider: makeProvider(), capabilities: FORM_CAPABLE })
    const round1 = { releases: [{ version: 'next', type: 'hotfix', description: 'urgent auth patch' }] }

    const gate = await tool(round1, accepted({ version: '1.63.1', type: 'regular' }))

    expect(gateOf(gate)).toMatchObject({
      resolvedArgs: { releases: [{ version: '1.63.1', type: 'regular', description: 'urgent auth patch' }] },
    })
  })

  it.each([
    [
      'drops a top-level key',
      () => {
        return { items: ['a', 'b'] }
      },
    ],
    [
      'shortens an array',
      () => {
        return { items: ['a'], label: 'x' }
      },
    ],
    [
      'grows an array',
      () => {
        return { items: ['a', 'b', 'c'], label: 'x' }
      },
    ],
    [
      'returns a non-record',
      () => {
        return [] as unknown as Record<string, unknown>
      },
    ],
  ])('f12: a provider whose toArgs %s is refused — the gate keeps the round-1 arguments', async (_label, toArgs) => {
    // Generic on purpose: no releases anywhere. The check is about SHAPE — keys and array lengths —
    // and the chokepoint must stay domain-blind.
    const round1 = { items: ['a', 'b'], label: 'x' }
    const { tool, handler } = formTool({
      provider: makeProvider({
        toArgs,
        buildRequestedSchema: async () => {
          return z.object({ label: z.string() })
        },
      }),
      capabilities: FORM_CAPABLE,
    })

    const gate = await tool(round1, accepted({ label: 'y' }))
    const confirmToken = gateToken(gate)

    expect(gateOf(gate)).toMatchObject({ status: 'confirmation_required', resolvedArgs: round1, formDiscarded: true })
    await expect(tool({ ...round1, confirm: true, confirmToken })).resolves.toBe(payload)
    expect(handler).toHaveBeenCalledWith({ ...round1, confirm: true, confirmToken, confirmedCommand: true })
  })

  it('f13: an asynchronously-validating schema yields a form on round 1, and a gate on re-entry', async () => {
    // TWO phases, because a single call passes identically with the wrap removed: an async
    // refinement is not a wire-shape violation, so `elicit()` converts it cleanly and round 1 never
    // reaches `acceptedContent` — measured on this repo's zod 4.5.2.
    const { tool, handler } = formTool({
      provider: makeProvider({
        buildRequestedSchema: async () => {
          return z.object({ version: z.string() }).refine(
            async () => {
              return true
            },
            { message: 'always' },
          )
        },
      }),
      capabilities: FORM_CAPABLE,
    })
    const round1 = { releases: [{ version: 'next', type: 'hotfix' }] }

    const phase1 = await tool(round1)

    expect(asForm(phase1).resultType).toBe('input_required')

    const phase2 = await tool(round1, accepted({ version: '1.63.1' }))

    expect(isForm(phase2)).toBe(false)
    expect(gateOf(phase2)).toMatchObject({ status: 'confirmation_required', resolvedArgs: round1, formDiscarded: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('logs the form request and the form decline, each exactly once', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(logger, 'info').mockImplementation((entry: unknown) => {
      lines.push(String((entry as { msg?: unknown }).msg))
    })
    const { tool } = formTool({ provider: makeProvider(), capabilities: FORM_CAPABLE })
    const round1 = { releases: [{ version: 'next' }] }

    await tool(round1)
    await tool(round1, reentry({ action: 'decline' }))
    spy.mockRestore()

    expect(
      lines.filter((line) => {
        return line === 'Tool execution form requested: release-create'
      }),
    ).toHaveLength(1)
    expect(
      lines.filter((line) => {
        return line === 'Tool execution form declined (decline): release-create'
      }),
    ).toHaveLength(1)
  })
})
