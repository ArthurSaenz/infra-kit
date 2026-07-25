import { commandEcho } from 'src/lib/command-echo'
import { ensureUserProjectConfig } from 'src/lib/config-bootstrap'
import { logger } from 'src/lib/logger'
import { textContent } from 'src/types'
import type { ToolsExecutionResult } from 'src/types'

interface ToolHandlerArgs {
  toolName: string
  handler: (params: any) => Promise<ToolsExecutionResult>
  /**
   * When true, this tool is gated by the destructive-op confirm gate below. Sourced from the
   * catalog tool's {@link CatalogMcpTool.requiresHumanConfirm} at registration (`mcp/tools/index.ts`).
   */
  requiresHumanConfirm?: boolean
}

/** True when the incoming MCP params carry an explicit `confirm:true` (the call-2 execute signal). */
const isConfirmed = (params: unknown): boolean => {
  return typeof params === 'object' && params !== null && (params as { confirm?: unknown }).confirm === true
}

/**
 * The call-1 gate response for a `requiresHumanConfirm` tool: it names the tool and echoes the
 * resolved args (minus the `confirm` flag itself) and tells the caller to re-invoke with
 * `confirm:true`. Crucially it sets `isError: true` — the MCP SDK validates a result's
 * `structuredContent` against the tool's `outputSchema` UNLESS `isError` is set (server/mcp.js
 * `validateToolOutput`), and every gated tool declares an outputSchema the gate payload does not
 * match, so without `isError` the real server would throw an output-validation error instead of
 * returning the gate. This is a soft stop, not a failure: the tool did NOT run.
 */
const buildConfirmGate = (toolName: string, params: unknown): ToolsExecutionResult => {
  const resolvedArgs =
    typeof params === 'object' && params !== null
      ? Object.fromEntries(
          Object.entries(params as Record<string, unknown>).filter(([key]) => {
            return key !== 'confirm'
          }),
        )
      : {}

  const structuredContent = {
    status: 'confirmation_required' as const,
    tool: toolName,
    resolvedArgs,
    message: `${toolName} mutates external state and is gated. It was NOT executed. Re-call ${toolName} with the same arguments plus "confirm": true to execute.`,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
    isError: true,
  }
}

export const createToolHandler = ({
  toolName,
  handler,
  requiresHumanConfirm,
}: ToolHandlerArgs): ((params: unknown) => Promise<ToolsExecutionResult>) => {
  return async (params: unknown) => {
    logger.info({ msg: `Tool execution started: ${toolName}`, params })
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
      // re-enable. When a tool is flagged and the caller has not opted in with `confirm:true`, return
      // the resolved-args gate and DO NOT run the handler; a second call carrying `confirm:true` falls
      // through and executes exactly as an unflagged tool would.
      if (requiresHumanConfirm === true && !isConfirmed(params)) {
        logger.info({ msg: `Tool execution gated (awaiting confirm): ${toolName}` })

        return buildConfirmGate(toolName, params)
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
