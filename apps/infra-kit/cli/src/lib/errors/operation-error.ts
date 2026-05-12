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
const extractStderr = (cause: unknown): string | undefined => {
  if (cause === null || typeof cause !== 'object') return undefined
  const stderr = (cause as { stderr?: unknown }).stderr

  return typeof stderr === 'string' && stderr.length > 0 ? stderr : undefined
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
 * `src/integrations/doppler/doppler-cli-auth.ts`.
 *
 * @example
 * // wrap a zx subprocess failure
 * try {
 *   await $`git worktree add ${path} ${branch}`
 * } catch (err) {
 *   throw new OperationError(err, {
 *     operation: `git worktree add for ${branch}`,
 *     remediation: 'check the branch name and that the parent dir is writable',
 *   })
 * }
 *
 * @example
 * // validation failure with no underlying cause
 * throw new OperationError(undefined, {
 *   operation: 'launch deploy-all workflow',
 *   remediation: `pass one of: ${environments.join(', ')}`,
 *   stderrExcerpt: `invalid environment: ${selectedEnv}`,
 * })
 */
export class OperationError extends Error {
  readonly operation: string
  readonly remediation?: string

  constructor(cause: unknown, ctx: OperationErrorContext) {
    super(buildMessage(cause, ctx), { cause })
    this.name = 'OperationError'
    this.operation = ctx.operation
    this.remediation = ctx.remediation
  }
}
