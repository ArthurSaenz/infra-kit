import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { getExposedMcpTools } from 'src/lib/command-catalog'
import { createToolHandler } from 'src/lib/tool-handler'

export const initializeTools = async (server: McpServer) => {
  // The registered tool set is derived from the single command catalog, filtered
  // by its explicit `mcpExposed` allowlist. doctor is intentionally excluded there
  // (host-inspecting) and must never be registered here.
  for (const tool of getExposedMcpTools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // Wrapped HERE, at the single `registerTool` call site, rather than in the 24
        // `defineMcpTool` definitions or in `CatalogMcpTool`. SDK v2 offers a deprecated
        // raw-shape overload that would auto-wrap, but it types the shape as its own
        // `ZodRawShape` (`Record<string, ZodType>`) while zod 4's `z.ZodRawShape` is the
        // looser `Readonly<{ [k: string]: $ZodType }>` — `$ZodType` lacks `def`/`type`/`_def`
        // and ~42 other members, so the raw shape is NOT assignable and the overload is
        // unreachable for us. `z.object()` closes that gap and lands on v2's PREFERRED
        // (non-deprecated) Standard Schema overload, since a `ZodObject` carries `~standard`.
        //
        // Wrapping here keeps the authoring shape in all 24 `src/commands/**` definitions
        // unchanged and leaves `defineMcpTool`'s `z.infer<z.ZodObject<TIn>>` handler typing
        // untouched — the migration needs zero edits under `src/commands/`.
        inputSchema: z.object(tool.inputSchema),
        outputSchema: z.object(tool.outputSchema),
      },
      createToolHandler({
        toolName: tool.name,
        handler: tool.handler,
        requiresHumanConfirm: tool.requiresHumanConfirm,
      }),
    )
  }
}
