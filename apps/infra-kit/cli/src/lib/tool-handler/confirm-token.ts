import { createRequestStateCodec } from '@modelcontextprotocol/server'
import { randomBytes } from 'node:crypto'

/**
 * @fileoverview
 *
 * Round-1 gate payload → round-2 binding for the destructive-op confirm gate.
 *
 * Round 1 mints a `confirmToken` over the tool name and the CANONICAL form of the
 * arguments; round 2 must present that token together with the same arguments, or
 * the tool does not run.
 *
 * Without the binding an agent could obtain a gate for `env:dev` and re-call with
 * `confirm:true` for `env:prod` — the substitution hole
 * `docs/infra-kit-slash-commands-plan.md` §0.12 records.
 */

/** Keys the gate itself owns; they are never part of the signed argument set. */
const GATE_KEYS = new Set(['confirm', 'confirmToken'])

/** Default token lifetime. Long enough for a human to read the gate, short enough to bound replay. */
export const CONFIRM_TOKEN_TTL_SECONDS = 600

/** What a round-1 gate signs. `args` is the canonical JSON of the tool arguments. */
export interface ConfirmPayload {
  args: string
}

/** The subset of the SDK codec the gate uses; `ctx` is the tool name the token is bound to. */
export interface ConfirmCodec {
  mint: (payload: ConfirmPayload, toolName: string) => Promise<string>
  verify: (token: string, toolName: string) => Promise<ConfirmPayload>
}

export type ConfirmRefusal = 'absent' | 'malformed' | 'mac' | 'expired' | 'bind' | 'mismatch'

interface BindContext {
  toolName: string
}

type SdkBindContext = NonNullable<Parameters<ReturnType<typeof createRequestStateCodec>['mint']>[1]>

const asBindContext = (toolName: string): SdkBindContext => {
  return { toolName } as unknown as SdkBindContext
}

export type ConfirmVerdict = { ok: true } | { ok: false; reason: ConfirmRefusal }

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>

    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => {
          return [key, sortKeysDeep(record[key])]
        }),
    )
  }

  return value
}

/**
 * Stable JSON for an argument object: keys sorted recursively, arrays kept in order.
 * `JSON.stringify` is key-order-sensitive and round-2 arguments are re-serialized by
 * the client in whatever order the host emits, so signing or verifying the raw form
 * would refuse legitimate confirmations intermittently, per client.
 *
 * @example
 * canonicalArgs({ b: 2, a: { d: 1, c: [2, 1] } }) // => '{"a":{"c":[2,1],"d":1},"b":2}'
 */
export const canonicalArgs = (args: unknown): string => {
  return JSON.stringify(sortKeysDeep(args))
}

/**
 * The tool's own arguments: the incoming params with the gate's keys removed. This is
 * the ONE filter both rounds share, so round 2 (which carries `confirm` and
 * `confirmToken` on top of round 1's arguments) verifies against exactly what round 1 signed.
 *
 * @example
 * stripGateKeys({ env: 'dev', confirm: true, confirmToken: 'v1.x.y' }) // => { env: 'dev' }
 */
export const stripGateKeys = (params: unknown): Record<string, unknown> => {
  if (typeof params !== 'object' || params === null) return {}

  return Object.fromEntries(
    Object.entries(params as Record<string, unknown>).filter(([key]) => {
      return !GATE_KEYS.has(key)
    }),
  )
}

/**
 * Build the gate's codec. The key is per-process and random by default: one stdio
 * server process serves both rounds of every confirmation, so a key that dies with
 * the process is sufficient — that stops being true on any HTTP transport, where the
 * key would have to be shared across workers. Tests inject a short `ttlSeconds` or a
 * second key to exercise the expiry and tamper refusals.
 *
 * @example
 * const codec = createConfirmCodec()
 * const token = await codec.mint({ args: '{"env":"dev"}' }, 'env-clear')
 * await codec.verify(token, 'env-clear') // => { args: '{"env":"dev"}' }
 */
export const createConfirmCodec = (options: { key?: Uint8Array; ttlSeconds?: number } = {}): ConfirmCodec => {
  // The SDK types the bind context as its own `ServerContext`; the gate only ever binds to the
  // tool name, so a one-field object stands in for it on both mint and verify.
  const codec = createRequestStateCodec<ConfirmPayload>({
    key: options.key ?? randomBytes(32),
    ttlSeconds: options.ttlSeconds ?? CONFIRM_TOKEN_TTL_SECONDS,
    bind: (ctx) => {
      return (ctx as unknown as BindContext).toolName
    },
  })

  return {
    mint: (payload, toolName) => {
      return codec.mint(payload, asBindContext(toolName))
    },
    verify: (token, toolName) => {
      return codec.verify(token, asBindContext(toolName))
    },
  }
}

let defaultCodec: ConfirmCodec | undefined

/** The process-wide codec every registered tool shares, created on first use. */
export const getDefaultConfirmCodec = (): ConfirmCodec => {
  defaultCodec ??= createConfirmCodec()

  return defaultCodec
}

const readConfirmToken = (params: unknown): string | undefined => {
  if (typeof params !== 'object' || params === null) return undefined

  const { confirmToken } = params as { confirmToken?: unknown }

  return typeof confirmToken === 'string' ? confirmToken : undefined
}

const REFUSALS_FROM_CODEC: ReadonlySet<ConfirmRefusal> = new Set(['malformed', 'mac', 'expired', 'bind'])

const codecRefusal = (error: unknown): ConfirmRefusal => {
  const message = error instanceof Error ? error.message : ''

  return REFUSALS_FROM_CODEC.has(message as ConfirmRefusal) ? (message as ConfirmRefusal) : 'malformed'
}

/**
 * Mint the round-1 token for `params` (gate keys excluded), bound to `toolName`.
 *
 * @example
 * await mintConfirmToken(codec, 'env-clear', { env: 'dev' }) // => 'v1.<payload>.<mac>'
 */
export const mintConfirmToken = async (codec: ConfirmCodec, toolName: string, params: unknown): Promise<string> => {
  return codec.mint({ args: canonicalArgs(stripGateKeys(params)) }, toolName)
}

/**
 * Decide whether a round-2 call may run. Absence is a refusal in its own right —
 * "verify only when a token is present" would let an agent omit the token and
 * substitute arguments freely, reopening the hole this module closes.
 *
 * @example
 * await verifyConfirmToken(codec, 'env-clear', { env: 'prod', confirm: true, confirmToken })
 * // => { ok: false, reason: 'mismatch' }  (the token was minted for env:dev)
 */
export const verifyConfirmToken = async (
  codec: ConfirmCodec,
  toolName: string,
  params: unknown,
): Promise<ConfirmVerdict> => {
  const token = readConfirmToken(params)

  if (token === undefined) return { ok: false, reason: 'absent' }

  let payload: ConfirmPayload

  try {
    payload = await codec.verify(token, toolName)
  } catch (error) {
    return { ok: false, reason: codecRefusal(error) }
  }

  if (payload.args !== canonicalArgs(stripGateKeys(params))) return { ok: false, reason: 'mismatch' }

  return { ok: true }
}
