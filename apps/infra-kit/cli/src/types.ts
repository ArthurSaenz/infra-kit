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

/**
 * The per-tool seam that lets the domain-blind confirm chokepoint in `lib/tool-handler` collect a
 * tool's arguments from a HUMAN via an MCP elicitation form, without learning anything about the
 * tool's domain. The chokepoint asks only "is there a provider?" and "can this client render a
 * form?"; every domain-specific answer lives behind these three members.
 *
 * Nothing consumes this yet — it is declared here so the registration path can forward it while the
 * state machine that reads it lands separately.
 */
export interface ArgumentFormProvider {
  /** Human-facing prompt rendered above the form. */
  message: string
  /**
   * Whether a form is WORTH opening for THESE arguments. Pure, synchronous, never
   * throws; `false` sends the call straight to the gate with its arguments intact.
   * Defaults to `false` on anything it does not recognise.
   *
   * NOT load-bearing for TRUNCATION: the chokepoint's non-narrowing check
   * catches top-level key removal and any array length change — shortening OR
   * growth — which no provider can weaken. The check is load-bearing for NOTHING
   * ELSE: it does not look at nested keys or at values, so it does NOT cover a
   * form that drops `releases[0].type`. Do not read this as "the chokepoint has
   * it covered": for anything below the top level, `toArgs`'s merge is the only
   * control.
   */
  isFormable: (params: unknown) => boolean
  /**
   * Candidate values for THIS tool's arguments, as a zod object (a Standard
   * Schema — `inputRequired.elicit` accepts one). Returned rather than inlined so
   * the SAME schema validates the response on re-entry.
   *
   * Contract: never throws, never blocks past the caller's deadline, and returns
   * `null` when it cannot offer real values — which the handler reads as "no
   * form" and falls to the gate.
   *
   * Also: **validates SYNCHRONOUSLY — no `.refine(async …)` anywhere in the
   * object.** `acceptedContent`'s schema-aware overload throws a `TypeError` on an
   * asynchronously-validating schema, and the declared return type
   * `z.ZodObject<z.ZodRawShape>` cannot express that constraint — so it is stated
   * here and backstopped by a wrap at the call site.
   */
  buildRequestedSchema: (params: unknown) => Promise<z.ZodObject<z.ZodRawShape> | null>
  /**
   * MERGES validated form content over the round-1 `params` — never constructs a
   * fresh argument object. The form overwrites field-by-field and only where the
   * human supplied a value; untouched fields keep their round-1 value.
   *
   * Contract: TOTAL over anything `buildRequestedSchema`'s own schema accepts,
   * and NEVER THROWS — it is the one member called on client-supplied input, and
   * a throw here escapes the chokepoint's catch as a tool error where a gate was
   * owed. It returns `null` if it cannot map, which the handler treats exactly as
   * a validation failure: gate, with the round-1 arguments.
   */
  toArgs: (content: Record<string, unknown>, params: unknown) => Record<string, unknown> | null
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
  /**
   * Optional per-tool {@link ArgumentFormProvider}. Present means "this tool can offer the human a
   * form for its arguments"; absent means the confirm gate behaves exactly as it always has. It is
   * ORTHOGONAL to `requiresHumanConfirm` as a declaration, though only a gated tool can reach a form
   * — the form is collected on the way INTO the gate, never instead of it.
   */
  formProvider?: ArgumentFormProvider
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
