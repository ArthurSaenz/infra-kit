import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server'
import type { ClientCapabilities, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { getExposedMcpTools } from 'src/lib/command-catalog'
import { createToolHandler } from 'src/lib/tool-handler'
import type { ToolCallContext } from 'src/lib/tool-handler'

export const initializeTools = async (server: McpServer) => {
  // The registered tool set is derived from the single command catalog, filtered
  // by its explicit `mcpExposed` allowlist. Nothing is added or subtracted here —
  // an exposure decision that is not visible in the catalog is invisible to the
  // catalog's own gates, so this loop stays a plain projection of it.
  //
  // `doctor` IS exposed, and it is the one entry whose safety does not come from
  // those gates: it is `mutating: false` (read-only, ungated) purely because
  // `doctorMcpTool` is nullary and forwards nothing, so the CLI's `--fix` write path
  // is unreachable from MCP by construction. The P1 fail-closed gate only inspects
  // `mutating && mcpExposed` entries, so it cannot see that claim go false — the
  // guard is `src/commands/doctor/__tests__/doctor-mcp-surface.test.ts`, not this list.
  for (const tool of getExposedMcpTools()) {
    server.registerTool(
      tool.name,
      {
        // Display label; hosts fall back to `name` when absent. TOP-LEVEL `title` only —
        // `annotations.title` is deliberately left unset, because some hosts prefer the latter when
        // present and two titles are a divergence waiting to happen.
        title: tool.title,
        description: tool.description,
        // Wrapped HERE, at the single `registerTool` call site, rather than in the 27
        // `defineMcpTool` definitions or in `CatalogMcpTool`. SDK v2 offers a deprecated
        // raw-shape overload that would auto-wrap, but it types the shape as its own
        // `ZodRawShape` (`Record<string, ZodType>`) while zod 4's `z.ZodRawShape` is the
        // looser `Readonly<{ [k: string]: $ZodType }>` — `$ZodType` lacks `def`/`type`/`_def`
        // and ~42 other members, so the raw shape is NOT assignable and the overload is
        // unreachable for us. `z.object()` closes that gap and lands on v2's PREFERRED
        // (non-deprecated) Standard Schema overload, since a `ZodObject` carries `~standard`.
        //
        // Wrapping here keeps the authoring shape in all 27 `src/commands/**` definitions
        // unchanged and leaves `defineMcpTool`'s `z.infer<z.ZodObject<TIn>>` handler typing
        // untouched — the migration needs zero edits under `src/commands/`.
        //
        // Gated tools additionally accept `confirmToken` here, at the boundary: `z.object` strips
        // undeclared keys, so without this the round-2 token the gate hands out would never reach
        // `createToolHandler`'s verification and every confirmation would be refused as absent.
        inputSchema: z.object(
          tool.requiresHumanConfirm === true ? withConfirmToken(tool.inputSchema) : tool.inputSchema,
        ),
        outputSchema: z.object(tool.outputSchema),
        // ADVISORY protocol hints, derived in the catalog from `mutating`. The authority for
        // destructive operations remains `requiresHumanConfirm` + `lib/tool-handler`'s confirm gate;
        // nothing in that gate reads these, and the spec forbids a client treating them as security.
        annotations: tool.annotations,
        // `anthropic/requiresUserInteraction` rides here on `setup`, the one tool that carries it. It is the
        // only human gate on the MCP path: the host prompts on EVERY call, in `bypassPermissions` too,
        // and an allow rule cannot skip it. Undefined for every other tool, which is the same as absent.
        _meta: tool.meta,
      },
      // The SDK's second callback argument (session, request state, signal) is threaded through so
      // the handler signature lands once; the gate binds tokens by tool name and needs none of it.
      wrapForRegistration(
        createToolHandler({
          toolName: tool.name,
          handler: tool.handler,
          requiresHumanConfirm: tool.requiresHumanConfirm,
          formProvider: tool.formProvider,
          // `server.server` is the underlying protocol instance the McpServer facade wraps; the
          // integration test in `mcp/__tests__/server.test.ts` reaches through it the same way.
          //
          // Envelope FIRST, accessor second. On a 2026-era connection the capabilities ride in each
          // request's envelope, and over stdio nothing ever seeds the server-level accessor from it
          // (the SDK does that only in its HTTP entry) — so the accessor alone read `undefined` on
          // every modern-era stdio call and no form was ever offered there. The accessor still answers
          // for a 2025-era connection, whose requests carry no envelope.
          getClientCapabilities: (ctx) => {
            const fromEnvelope = ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined

            return fromEnvelope ?? server.server.getClientCapabilities()
          },
        }),
      ),
    )
  }
}

const withConfirmToken = (shape: z.ZodRawShape): z.ZodRawShape => {
  return {
    ...shape,
    confirmToken: z
      .string()
      .optional()
      .describe('Round-2 only: the token returned by the round-1 gate, proving the arguments are unchanged.'),
  }
}

const wrapForRegistration = (handle: ReturnType<typeof createToolHandler>) => {
  return (params: unknown, ctx: ToolCallContext) => {
    return handle(params, ctx)
  }
}
