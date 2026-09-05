import type { z } from 'zod'

export interface ToolsExecutionResult<TStructured = Record<string, unknown>> {
  [x: string]: unknown
  content: {
    type: 'text'
    text: string
  }[]
  structuredContent?: TStructured
}

export interface RequiredConfirmedOptionArg {
  confirmedCommand: boolean
}

export interface McpTool<TIn extends z.ZodRawShape = z.ZodRawShape, TOut extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  inputSchema: TIn
  outputSchema: TOut
  /**
   * When true, this tool is gated by the MCP destructive-op confirm gate (see `lib/tool-handler`):
   * a first call WITHOUT `confirm:true` returns a resolved-args gate response instead of running,
   * and only a second call carrying `confirm:true` executes. This is ORTHOGONAL to the
   * `confirmedCommand:true` the boundary always injects (a prompt-skip discriminator, not a gate).
   * Set only on genuinely destructive tools; the default-deny catalog test enforces coverage.
   */
  requiresHumanConfirm?: boolean
  handler: (
    params: z.infer<z.ZodObject<TIn>> & RequiredConfirmedOptionArg,
  ) => Promise<ToolsExecutionResult<z.infer<z.ZodObject<TOut>>>>
}

/**
 * Build the dual-channel content array shared by every MCP tool. Narrows the
 * literal `type: 'text'` so handlers can use inferred return types without TS
 * widening `type` to `string` — which would otherwise break assignability
 * against the MCP SDK's content union.
 *
 * @example
 * return {
 *   content: textContent(JSON.stringify(structuredContent, null, 2)),
 *   structuredContent,
 * }
 */
export const textContent = (text: string): ToolsExecutionResult['content'] => {
  return [{ type: 'text', text }]
}

/**
 * Factory that ties the handler's return type to the declared `outputSchema`
 * so `structuredContent` is checked against the schema at compile time. If a
 * handler accidentally drops or renames a field, TS errors at the registration
 * site rather than at runtime in an MCP client.
 *
 * @example
 * export const envLoadMcpTool = defineMcpTool({
 *   name: 'env-load',
 *   description: '...',
 *   inputSchema: { config: z.string() },
 *   outputSchema: { filePath: z.string(), variableCount: z.number() },
 *   handler: envLoad,
 * })
 */
export const defineMcpTool = <TIn extends z.ZodRawShape, TOut extends z.ZodRawShape>(
  tool: McpTool<TIn, TOut>,
): McpTool<TIn, TOut> => {
  return tool
}
