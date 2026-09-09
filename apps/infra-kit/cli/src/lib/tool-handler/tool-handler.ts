import type { ClientCapabilities, InputRequiredResult } from '@modelcontextprotocol/server'

import { commandEcho } from 'src/lib/command-echo'
import { ensureUserProjectConfig } from 'src/lib/config-bootstrap'
import { logger } from 'src/lib/logger'
import { textContent } from 'src/types'
import type { ArgumentFormProvider, ToolsExecutionResult } from 'src/types'

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
}

/**
 * The SDK hands every tool callback a second argument (session, request state, abort signal).
 * Threaded through untouched so the signature lands once; the gate itself needs none of it yet.
 */
export interface ToolCallContext {
  sessionId?: string
}

type GateState = 'run' | 'gate' | 'verify'

/** True when the incoming MCP params carry an explicit `confirm:true` (the call-2 execute signal). */
const isConfirmed = (params: unknown): boolean => {
  return typeof params === 'object' && params !== null && (params as { confirm?: unknown }).confirm === true
}

/**
 * First-match-wins, every condition complete: an ungated tool runs; a gated tool without
 * `confirm:true` gets the gate; a gated tool WITH it goes to verification — never back to the
 * gate, because a token-less round 2 that slid back to the gate would reopen the argument-
 * substitution hole (the refusal lives INSIDE `verify`, not in this discrimination).
 */
const resolveGateState = (requiresHumanConfirm: boolean | undefined, params: unknown): GateState => {
  // Spelled `=== true` on purpose: `mcp-confirm-gate-mutation.test.ts` neuters exactly this
  // predicate at build time to prove the gate's e2e assertions are load-bearing.
  if (requiresHumanConfirm === true) return isConfirmed(params) ? 'verify' : 'gate'

  return 'run'
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

/**
 * The round-1 gate: names the tool, echoes the arguments it will bind to, and carries the
 * `confirmToken` round 2 must return alongside `confirm:true` and the SAME arguments.
 */
const buildConfirmGate = async (
  codec: ConfirmCodec,
  toolName: string,
  params: unknown,
): Promise<ToolsExecutionResult> => {
  const resolvedArgs = stripGateKeys(params)
  const confirmToken = await mintConfirmToken(codec, toolName, params)

  return softStop({
    status: 'confirmation_required',
    tool: toolName,
    resolvedArgs,
    confirmToken,
    message: `${toolName} mutates external state and is gated. It was NOT executed. Re-call ${toolName} with the same arguments plus "confirm": true and this "confirmToken" to execute.`,
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
  confirmCodec,
}: ToolHandlerArgs): ((
  params: unknown,
  ctx?: ToolCallContext,
) => Promise<ToolsExecutionResult | InputRequiredResult>) => {
  const codec = confirmCodec ?? getDefaultConfirmCodec()

  // `ctx` is bound HERE, in the returned closure, and not merely declared on the exported type. The
  // SDK passes it on every call, so a closure that omits the parameter discards it silently while
  // the signature keeps advertising it — the gap survived PR 1 unnoticed for exactly that reason.
  // Nothing branches on it yet; the entry log records the session, which keeps the binding live
  // rather than a name TS would flag as unread.
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

      // Orthogonal destructive-op confirm gate. It sits BEFORE the handler and is INDEPENDENT of the
      // `confirmedCommand:true` injected below — that flag is a prompt-skip / behavior discriminator
      // (e.g. worktrees-remove keys `allowEditorRelaunch` off it) and MUST keep being injected on the
      // real call, or the non-TTY server would hang on an inquirer prompt and the Zed relaunch would
      // re-enable. Round 1 returns the gate with a token bound to the tool and its arguments; round 2
      // runs only when `confirm:true` comes with that token AND the same arguments.
      const state = resolveGateState(requiresHumanConfirm, params)

      if (state === 'gate') {
        logger.info({ msg: `Tool execution gated (awaiting confirm): ${toolName}` })

        return await buildConfirmGate(codec, toolName, params)
      }

      if (state === 'verify') {
        const verdict = await verifyConfirmToken(codec, toolName, params)

        if (!verdict.ok) {
          logger.info({ msg: `Tool execution refused (${verdict.reason}): ${toolName}` })

          return buildConfirmRefusal(toolName, verdict.reason)
        }
      }

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
