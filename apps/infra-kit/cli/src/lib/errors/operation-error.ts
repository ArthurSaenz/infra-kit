const STDERR_EXCERPT_MAX_BYTES = 200

export interface OperationErrorContext {
  operation: string
  remediation?: string
  stderrExcerpt?: string
}

/**
 * Duck-typed read of zx's `ProcessOutput.stderr` (and similar shapes) without
 * importing zx types just for an `instanceof` check.
 *
 * @example
 * extractStderr(new Error('x'))               // undefined
 * extractStderr({ stderr: 'fatal: ...' })     // 'fatal: ...'
 * extractStderr({ stderr: '' })               // undefined  (empty treated as missing)
 */
export const extractStderr = (cause: unknown): string | undefined => {
  // Walks the `cause` chain rather than reading one level. `OperationError` renders
  // `stderrExcerpt` into its message and keeps it on the instance, but an OperationError
  // wrapped in another OperationError — which is what `executeOne` does to every per-entry
  // failure — carries no `.stderr` of its own. Reading one level there returns undefined, so
  // the inner refusal's evidence would be silently dropped from the message the operator and
  // the MCP client actually see.
  const seen = new Set<unknown>()
  let current = cause

  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)

    const { stderr, stderrExcerpt } = current as { stderr?: unknown; stderrExcerpt?: unknown }

    if (typeof stderr === 'string' && stderr.length > 0) return stderr
    if (typeof stderrExcerpt === 'string' && stderrExcerpt.length > 0) return stderrExcerpt

    current = (current as { cause?: unknown }).cause
  }

  return undefined
}

/**
 * Compose the human-and-agent-readable message body for an `OperationError`:
 * `"failed to <operation> [— stderr: <excerpt>] [— try: <remediation>]"`.
 * `stderrExcerpt` overrides anything duck-typed off `cause`; both are trimmed
 * and capped at {@link STDERR_EXCERPT_MAX_BYTES} so a runaway subprocess can't
 * blow up the message.
 */
const buildMessage = (cause: unknown, ctx: OperationErrorContext): string => {
  const stderr = ctx.stderrExcerpt ?? extractStderr(cause)
  const parts = [`failed to ${ctx.operation}`]

  if (stderr) parts.push(`stderr: ${stderr.slice(0, STDERR_EXCERPT_MAX_BYTES).trim()}`)
  if (ctx.remediation) parts.push(`try: ${ctx.remediation}`)

  return parts.join(' — ')
}

/**
 * Error type for any handler-level failure that should surface to the caller
 * (CLI user or MCP-connected agent) with a remediation hint. Wraps an
 * underlying cause and renders a single-line, structured message so logs and
 * agent tool-result text stay scannable.
 *
 * Pattern modeled on the exemplary Doppler errors in
 * `src/integrations/doppler/doppler-errors.ts`.
 *
 * @example
 * throw new OperationError(err, {
 *   operation: `git worktree add for ${branch}`,
 *   remediation: 'check the branch name and that the parent dir is writable',
 * })
 * @example
 * // validation failure, with no underlying cause to wrap
 * throw new OperationError(undefined, { operation: 'launch deploy-all workflow', remediation })
 */
export class OperationError extends Error {
  readonly operation: string
  readonly remediation?: string
  /**
   * Kept on the instance, not merely rendered into the message: this error is routinely
   * re-wrapped in another `OperationError` (see `executeOne`), and {@link extractStderr}
   * walks the `cause` chain looking for exactly this field. Without it the outer message
   * reports only its own generic remediation and the real reason disappears.
   */
  readonly stderrExcerpt?: string

  constructor(cause: unknown, ctx: OperationErrorContext) {
    super(buildMessage(cause, ctx), { cause })
    this.name = 'OperationError'
    this.operation = ctx.operation
    this.remediation = ctx.remediation
    this.stderrExcerpt = ctx.stderrExcerpt ?? extractStderr(cause)
  }
}
