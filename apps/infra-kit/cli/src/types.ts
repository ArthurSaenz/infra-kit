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
 * The per-tool seam that lets the domain-blind `refuseMissingArguments` describe a tool's arguments
 * as a form — the `choices` an agent's refusal carries — without learning anything about the tool's
 * domain. It asks only "is there a provider?" and "is this input formable?"; every domain-specific
 * answer lives behind these three members.
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
   * The catalog's own "this mutation is gated by `confirmOrExit`" declaration — the only machine-readable
   * link between the catalog's `mutating` flag and `confirmOrExit`: a run without `--yes` previews its
   * plan and exits, and only a re-run carrying `--yes` executes. Set only on genuinely destructive
   * tools; the default-deny catalog test enforces coverage.
   */
  requiresHumanConfirm?: boolean
  /**
   * Optional per-tool {@link ArgumentFormProvider}. Present means "this command can describe a form for
   * its arguments", which `refuseMissingArguments` renders as the `choices` of an agent's refusal. It is
   * ORTHOGONAL to `requiresHumanConfirm`: a form answer is an ARGUMENT, not consent — the re-run still
   * meets `confirmOrExit`, and the form path can execute nothing a direct call with the same arguments
   * could not.
   */
  formProvider?: ArgumentFormProvider
  handler: (
    params: z.infer<z.ZodObject<TIn>> & RequiredConfirmedOptionArg,
  ) => Promise<ToolsExecutionResult<z.infer<z.ZodObject<TOut>>>>
}

/**
 * Build the `content` half of a handler result. Narrows the literal `type: 'text'`
 * so handlers can use inferred return types without TS widening `type` to
 * `string` — the shape is the retired server's, kept because every handler and
 * every handler test is written against it and `--json` reads only
 * `structuredContent`.
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
 * handler accidentally drops or renames a field, TS errors at the declaration
 * site rather than in whatever parses the `--json` document.
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
