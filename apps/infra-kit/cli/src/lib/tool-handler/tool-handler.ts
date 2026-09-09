import type { ClientCapabilities, InputRequiredResult } from '@modelcontextprotocol/server'

import { commandEcho } from 'src/lib/command-echo'
import { ensureUserProjectConfig } from 'src/lib/config-bootstrap'
import { logger } from 'src/lib/logger'
import { textContent } from 'src/types'
import type { ArgumentFormProvider, ToolsExecutionResult } from 'src/types'

import { FORM_DEADLINE_MS, buildArgumentForm, narrowsArgs, readAcceptedArgs, readFormAction } from './argument-form'
import type { FormAction } from './argument-form'
import { getDefaultConfirmCodec, mintConfirmToken, stripGateKeys, verifyConfirmToken } from './confirm-token'
import type { ConfirmCodec, ConfirmRefusal } from './confirm-token'

interface ToolHandlerArgs {
  toolName: string
  handler: (params: any) => Promise<ToolsExecutionResult>
  /**
   * When true, this tool is gated by the destructive-op confirm gate below. Sourced from the
   * catalog tool's {@link CatalogMcpTool.requiresHumanConfirm} at registration (`mcp/tools/index.ts`).
   */
  requiresHumanConfirm?: boolean
  /**
   * Optional per-tool argument-form seam, sourced from the catalog tool's
   * {@link CatalogMcpTool.formProvider} at registration. Absent on every tool today, and nothing here
   * reads it yet: it is declared so registration can forward it while the state machine that consumes
   * it lands separately. Absent must always mean "the gate behaves exactly as it always has".
   */
  formProvider?: ArgumentFormProvider
  /**
   * Reads the connected client's declared capabilities, so the chokepoint can ask whether this client
   * can render a form at all before offering one. Injected as a CLOSURE rather than a value because
   * capabilities are only known after initialize, and this handler is built at registration time —
   * and because the accessor behind it is deprecated in favour of the per-request envelope, so the
   * migration is a one-line change at the injection site rather than an edit in here.
   */
  getClientCapabilities?: () => ClientCapabilities | undefined
  /** Token codec for the gate. Defaults to the process-wide one; tests inject short-TTL or foreign-key codecs. */
  confirmCodec?: ConfirmCodec
  /**
   * How long the form path waits for {@link ArgumentFormProvider.buildRequestedSchema}. Defaults to
   * {@link FORM_DEADLINE_MS}; tests inject a few milliseconds so the deadline lane asserts a bound
   * instead of hanging until the runner's own timeout.
   */
  formDeadlineMs?: number
}

/**
 * The SDK hands every tool callback a second argument (session, request state, abort signal).
 * Threaded through untouched so the signature lands once.
 */
export interface ToolCallContext {
  sessionId?: string
  /**
   * The per-request MCP envelope. Only the multi-round-trip carrier is declared: `inputResponses`
   * is how a client's answer to the argument form comes BACK, and its presence — not its content —
   * is what separates a first call from a re-entry.
   */
  mcpReq?: {
    inputResponses?: Record<string, unknown>
    /**
     * Keys the SDK dropped because they were not bare response objects. Declared for completeness
     * and deliberately UNREAD: a dropped key is absent from `inputResponses`, so it already reads
     * as `{kind:'missing'}` — an action that is not an accept, which is the decline path.
     */
    droppedInputResponseKeys?: string[]
  }
}

export type GateState = 'run' | 'form' | 'declined' | 'gate' | 'verify'

/** Everything `resolveGateState` needs, all of it knowable BEFORE any work is done. */
export interface GateInputs {
  /** `requiresHumanConfirm === true` — spelled at the call site, not re-derived here. */
  gated: boolean
  /** The round-2 execute signal. */
  confirmed: boolean
  /** Present iff the client came BACK with an answer to the form. Content is irrelevant here. */
  responses: Record<string, unknown> | undefined
  /** The client declared form-mode elicitation. */
  canForm: boolean
  /** This tool carries an {@link ArgumentFormProvider}. */
  hasProvider: boolean
  /** The provider wants a form for THESE arguments. */
  formable: boolean
  /** The client came back with an ACCEPT specifically — decline, cancel and absence are all `false`. */
  accepted: boolean
}

/** True when the incoming MCP params carry an explicit `confirm:true` (the call-2 execute signal). */
const isConfirmed = (params: unknown): boolean => {
  return typeof params === 'object' && params !== null && (params as { confirm?: unknown }).confirm === true
}

/**
 * The CANDIDATE state for a call. First-match-wins, in the order written, **every condition stated
 * in full** — no row relies on an earlier row having excluded anything.
 *
 * It is a candidate, not a verdict: `form` is the one outcome that can decline itself, because
 * whether a form can actually be built is knowable only after the provider has run under a
 * deadline. The caller falls through to `gate` when it does. Every other outcome is terminal in
 * the caller's own body.
 */
// `!confirmed` is spelled on rows 1, 2 AND 3 for one reason: a non-elicitation round 2 carries
// `confirm:true` with no `inputResponses`, so without it row 3 matches, the call re-gates forever
// and `verify` is unreachable. `responses !== undefined` is likewise the ONLY first-call/came-back
// discriminator — `acceptedContent(...)` being falsy reads the same for decline, cancel and absence
// alike, which would send a decline back to the form and re-prompt forever.
//
// Exported for its OWN tests, and not re-exported from `index.ts`, so the package's public surface
// is unchanged. Some conjuncts are backed a second time downstream — `hasProvider` is also enforced
// by the provider narrowing in `buildFormOrGate` — so an end-to-end assertion cannot tell which
// guard held. Testing the predicate directly is what makes deleting one of them observable.
export const resolveGateState = (input: GateInputs): GateState => {
  // Spelled `=== true` at the call site that fills `gated`: `mcp-confirm-gate-mutation.test.ts`
  // neuters exactly that predicate at build time to prove the gate's e2e assertions are load-bearing.
  if (!input.gated) return 'run'

  if (
    input.gated &&
    !input.confirmed &&
    input.responses === undefined &&
    input.canForm &&
    input.hasProvider &&
    input.formable
  ) {
    return 'form'
  }

  if (input.gated && !input.confirmed && input.responses !== undefined && !input.accepted) return 'declined'

  if (input.gated && !input.confirmed && (input.responses === undefined || input.accepted)) return 'gate'

  // Row 4, condition complete: `gated ∧ confirmed`. Rows 2 and 3 partition `gated ∧ !confirmed`
  // between them — row 2 is `responses !== undefined ∧ !accepted`, row 3 its exact complement — so
  // this is reached on that condition and no other.
  return 'verify'
}

/**
 * Every gate and refusal payload sets `isError: true`: the MCP SDK validates a result's
 * `structuredContent` against the tool's `outputSchema` UNLESS `isError` is set, and no gated
 * tool's schema matches these payloads. A soft stop, not a failure — the tool did NOT run.
 */
const softStop = (structuredContent: Record<string, unknown>): ToolsExecutionResult => {
  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
    isError: true,
  }
}

/** What the gate must SAY beyond its standing instruction, and to whom the arguments belong. */
interface GateNotices {
  /**
   * The human answered the form and their answer was thrown away — it failed validation, or it
   * narrowed the arguments. The gate then presents the AGENT'S values for approval in place of the
   * ones the human just chose, so saying so is not decoration: an unlabelled swap of the whole
   * selection is a worse substitution than the single-field one the merge exists to prevent.
   */
  formDiscarded: boolean
  /** This tool carries a form provider at all. */
  hasProvider: boolean
}

const FORM_DISCARDED_CLAUSE =
  'The values you submitted in the form could NOT be applied and were DISCARDED — they failed validation or narrowed the arguments — so the arguments shown above are the ORIGINAL ones, not your selection.'

// PM-D: only one gated tool in eight carries a provider, so a user who learns "infra-kit asks me
// before it does this" from the one that does will read the other seven's silence as safety. The
// true rule is "no dialog ⇒ this tool has no provider", and nothing else in the payload says so.
const NO_FORM_CLAUSE =
  'This tool does not prompt for its arguments; you are being asked to approve the values shown above.'

/**
 * The round-1 gate: names the tool, echoes the arguments it will bind to, and carries the
 * `confirmToken` round 2 must return alongside `confirm:true` and the SAME arguments.
 */
const buildConfirmGate = async (
  codec: ConfirmCodec,
  toolName: string,
  params: unknown,
  notices: GateNotices,
): Promise<ToolsExecutionResult> => {
  const resolvedArgs = stripGateKeys(params)
  const confirmToken = await mintConfirmToken(codec, toolName, params)
  const message = [
    notices.formDiscarded ? FORM_DISCARDED_CLAUSE : undefined,
    `${toolName} mutates external state and is gated. It was NOT executed. Re-call ${toolName} with the same arguments plus "confirm": true and this "confirmToken" to execute.`,
    notices.hasProvider ? undefined : NO_FORM_CLAUSE,
  ]
    .filter((clause) => {
      return clause !== undefined
    })
    .join(' ')

  return softStop({
    status: 'confirmation_required',
    tool: toolName,
    resolvedArgs,
    confirmToken,
    // A field and not only prose: an agent reacts to `formDiscarded` programmatically, for the same
    // reason `status` and `reason` are fields here rather than sentences.
    formDiscarded: notices.formDiscarded,
    message,
  })
}

/**
 * The form was answered with anything other than an accept. Terminal, and deliberately NOT a second
 * form: re-issuing one on a decline is an infinite prompt loop with the human's "no" as its engine.
 */
const buildFormDeclined = (toolName: string, action: FormAction): ToolsExecutionResult => {
  return softStop({
    status: 'form_declined',
    tool: toolName,
    action,
    message: `${toolName} was NOT executed: the argument form came back as "${action}". No confirmation is pending — call ${toolName} again to start over.`,
  })
}

const REFUSAL_TEXT: Record<ConfirmRefusal, string> = {
  absent: 'no "confirmToken" was supplied',
  malformed: 'the "confirmToken" is malformed',
  mac: 'the "confirmToken" was not issued by this server',
  expired: 'the "confirmToken" has expired',
  bind: 'the "confirmToken" was issued for a different tool',
  mismatch: 'the arguments differ from the ones the "confirmToken" was issued for',
}

/** The round-2 refusal: a terminal stop, deliberately NOT a second gate. */
const buildConfirmRefusal = (toolName: string, reason: ConfirmRefusal): ToolsExecutionResult => {
  return softStop({
    status: 'confirmation_refused',
    tool: toolName,
    reason,
    message: `${toolName} was NOT executed: ${REFUSAL_TEXT[reason]}. Call ${toolName} again WITHOUT "confirm" to receive a fresh gate, then re-call with the same arguments plus "confirm": true and the returned "confirmToken".`,
  })
}

/** Everything the stop resolution below needs from the tool's registration. */
interface StopDeps {
  toolName: string
  codec: ConfirmCodec
  requiresHumanConfirm: boolean | undefined
  formProvider: ArgumentFormProvider | undefined
  getClientCapabilities: (() => ClientCapabilities | undefined) | undefined
  formDeadlineMs: number
}

/** The arguments the gate will bind its token to, and whether they replaced a discarded selection. */
interface GateArgs {
  params: unknown
  formDiscarded: boolean
}

/**
 * The arguments a gate reached from an ACCEPTED form should carry. The round-1 arguments on every
 * path except one: a validated, merged, non-narrowing result.
 *
 * A failure here never goes back to the form — that is the re-prompt loop through a second door —
 * and it never proceeds with the client's values either. It gates on what the agent originally
 * asked for, and says so.
 */
/**
 * Runs one form PREDICATE, treating any throw as `false`.
 *
 * `isFormable` and the capability probe are the two calls that decide whether a form is even
 * offered, and both run OUTSIDE the wraps `argument-form.ts` puts around `buildRequestedSchema`
 * and `toArgs`. Unwrapped, a provider that throws here escapes through the handler's outer catch
 * as a TOOL ERROR on a call that was owed a GATE — the exact failure those wraps exist to prevent,
 * reached one step earlier.
 *
 * `types.ts` states a never-throws contract for `isFormable`, but a contract is not a mechanism:
 * it is enforced per provider, which is the residual class the chokepoint's non-narrowing check was
 * adopted to remove. Failing to `false` here means the worst a broken predicate can do is decline a
 * form the human would have seen — never skip the gate, never reach the handler.
 */
const tryPredicate = (read: () => boolean): boolean => {
  try {
    return read()
  } catch {
    return false
  }
}

const resolveGateArgs = async (
  deps: StopDeps,
  params: unknown,
  responses: Record<string, unknown> | undefined,
  formAction: FormAction,
): Promise<GateArgs> => {
  const provider = deps.formProvider

  if (provider === undefined || formAction !== 'accept') return { params, formDiscarded: false }

  const merged = await readAcceptedArgs(provider, params, responses, deps.formDeadlineMs)

  if (merged === null) {
    logger.info({ msg: `Tool execution form discarded (validation): ${deps.toolName}` })

    return { params, formDiscarded: true }
  }

  // Compared against `stripGateKeys(params)` — the same normalization the token is minted over, so
  // the check and the signature are looking at exactly one thing.
  if (narrowsArgs(stripGateKeys(params), merged)) {
    logger.info({ msg: `Tool execution form discarded (narrowed): ${deps.toolName}` })

    return { params, formDiscarded: true }
  }

  return { params: merged, formDiscarded: false }
}

/**
 * States `form` and `gate`. `form` is the one candidate that can decline itself: a provider that
 * rejects, outruns its deadline, resolves `null`, or hands `elicit()` a shape it cannot express
 * falls through to the gate here, with today's behaviour and no thrown error.
 */
const buildFormOrGate = async (
  deps: StopDeps,
  params: unknown,
  responses: Record<string, unknown> | undefined,
  state: GateState,
  formAction: FormAction,
): Promise<ToolsExecutionResult | InputRequiredResult> => {
  if (state === 'form' && deps.formProvider !== undefined) {
    const form = await buildArgumentForm(deps.formProvider, params, deps.formDeadlineMs)

    if (form !== null) {
      logger.info({ msg: `Tool execution form requested: ${deps.toolName}` })

      return form
    }

    logger.info({ msg: `Tool execution form unavailable: ${deps.toolName}` })
  }

  const gateArgs = await resolveGateArgs(deps, params, responses, formAction)

  logger.info({ msg: `Tool execution gated (awaiting confirm): ${deps.toolName}` })

  return await buildConfirmGate(deps.codec, deps.toolName, gateArgs.params, {
    formDiscarded: gateArgs.formDiscarded,
    hasProvider: deps.formProvider !== undefined,
  })
}

/**
 * The chokepoint's answer for a call, or `null` meaning "nothing stops this; run the handler".
 *
 * @example
 * await resolveStop(deps, { env: 'prod' }, undefined) // => the round-1 confirm gate
 */
const resolveStop = async (
  deps: StopDeps,
  params: unknown,
  ctx: ToolCallContext | undefined,
): Promise<ToolsExecutionResult | InputRequiredResult | null> => {
  const responses = ctx?.mcpReq?.inputResponses
  const formAction = readFormAction(responses)
  const state = resolveGateState({
    // Spelled `=== true` on purpose: `mcp-confirm-gate-mutation.test.ts` neuters exactly this
    // predicate at build time to prove the gate's e2e assertions are load-bearing.
    gated: deps.requiresHumanConfirm === true,
    confirmed: isConfirmed(params),
    responses,
    // `caps?.elicitation?.form`, NEVER `caps?.elicitation`: the SDK normalizes a bare
    // `{elicitation:{}}` to `{elicitation:{form:{}}}`, so both spellings agree on every fixture
    // except a url-only client — which is exactly the client that must NOT be offered a form.
    canForm: tryPredicate(() => {
      return deps.getClientCapabilities?.()?.elicitation?.form !== undefined
    }),
    hasProvider: deps.formProvider !== undefined,
    formable: tryPredicate(() => {
      return deps.formProvider?.isFormable(params) === true
    }),
    accepted: formAction === 'accept',
  })

  if (state === 'run') return null

  if (state === 'declined') {
    logger.info({ msg: `Tool execution form declined (${formAction}): ${deps.toolName}` })

    return buildFormDeclined(deps.toolName, formAction)
  }

  if (state === 'verify') {
    const verdict = await verifyConfirmToken(deps.codec, deps.toolName, params)

    if (verdict.ok) return null

    logger.info({ msg: `Tool execution refused (${verdict.reason}): ${deps.toolName}` })

    return buildConfirmRefusal(deps.toolName, verdict.reason)
  }

  return await buildFormOrGate(deps, params, responses, state, formAction)
}

// The return is a union because the chokepoint can now answer a call with an `InputRequiredResult` —
// the SDK's "I need input from the human before I can run" reply — as well as with a tool result.
// It typechecks at the registration site because `ToolCallback` already returns
// `CallToolResult | InputRequiredResult`.
//
// Deliberately UNCONDITIONAL, though nothing returns the second member yet. Narrowing it back for
// callers that pass no `formProvider` would be asserting "no provider means a form is unreachable" —
// true only while the state machine keeps requiring a provider, and enforced by nothing if that ever
// changes. Every caller narrows the union explicitly instead.
export const createToolHandler = ({
  toolName,
  handler,
  requiresHumanConfirm,
  formProvider,
  getClientCapabilities,
  confirmCodec,
  formDeadlineMs,
}: ToolHandlerArgs): ((
  params: unknown,
  ctx?: ToolCallContext,
) => Promise<ToolsExecutionResult | InputRequiredResult>) => {
  const deps: StopDeps = {
    toolName,
    codec: confirmCodec ?? getDefaultConfirmCodec(),
    requiresHumanConfirm,
    formProvider,
    getClientCapabilities,
    formDeadlineMs: formDeadlineMs ?? FORM_DEADLINE_MS,
  }

  // `ctx` is bound HERE, in the returned closure, and not merely declared on the exported type. The
  // SDK passes it on every call, so a closure that omits the parameter discards it silently while
  // the signature keeps advertising it — the gap survived PR 1 unnoticed for exactly that reason.
  return async (params: unknown, ctx?: ToolCallContext) => {
    logger.info({ msg: `Tool execution started: ${toolName}`, params, sessionId: ctx?.sessionId })
    try {
      // MCP entry-boundary seed. This wrapper is the sole chokepoint for every exposed tool
      // (`src/mcp/tools/index.ts` holds the only `registerTool` call), and the `mcp` command itself is
      // in program.ts's SEED_EXCLUDED — so an MCP server seeds lazily, on its FIRST tool invocation,
      // and a server that never receives one never writes to $HOME. The once-per-process guard inside
      // ensureUserProjectConfig makes calls 2..N free on this long-lived process.
      //
      // Deliberately INSIDE the try, not before it: defense-in-depth. ensureUserProjectConfig is
      // contractually never-throw, but if that contract ever broke, an unhandled rejection here would
      // take down the long-lived server. Inside the try it degrades to an ordinary tool error.
      await ensureUserProjectConfig()

      // The command handlers record their resolved flags into the `commandEcho` singleton. On the CLI,
      // Commander's `preAction` clears it before every command; this long-lived server never runs that
      // hook, so without a reset here one tool call's flags would leak into the next one's snapshot and
      // the options array would grow for the life of the process.
      commandEcho.reset()

      // Orthogonal destructive-op confirm gate, and the argument form that feeds it. Both sit BEFORE
      // the handler and are INDEPENDENT of the `confirmedCommand:true` injected below — that flag is a
      // prompt-skip / behavior discriminator (e.g. worktrees-remove keys `allowEditorRelaunch` off it)
      // and MUST keep being injected on the real call, or the non-TTY server would hang on an inquirer
      // prompt and the Zed relaunch would re-enable. The form is collected on the way INTO the gate,
      // never instead of it: round 1 returns a form or the gate, and round 2 runs only when
      // `confirm:true` comes with that gate's token AND the same arguments.
      const stop = await resolveStop(deps, params, ctx)

      if (stop !== null) return stop

      const payload = await handler({ ...(params as object), confirmedCommand: true })

      logger.info({ msg: `Tool execution successful: ${toolName}` })

      return payload
    } catch (error) {
      logger.error({
        err: error,
        params,
        msg: `Tool execution failed: ${toolName}`,
      })

      throw error
    }
  }
}
