const STDERR_EXCERPT_MAX_BYTES = 500
const STDOUT_EXCERPT_MAX_BYTES = 200

export interface ZxErrorFields {
  exitCode?: number | null
  stderr?: string
  stdout?: string
  message?: string
  name?: string
}

const readTrimmedString = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) return undefined

  return value.slice(-max).trim()
}

/**
 * Extract loggable fields from an error for `logger.error({ err: formatZxError(e) }, ...)`.
 *
 * pino's default `err` serializer handles `Error` subclasses but renders zx's
 * `ProcessOutput` as `{}` because its informative fields (`stderr`, `stdout`,
 * `exitCode`) are non-enumerable / on the prototype. This helper duck-types
 * those fields so subprocess failures surface in logs instead of vanishing.
 */
export const formatZxError = (error: unknown): ZxErrorFields => {
  if (error === null || typeof error !== 'object') {
    return { message: String(error) }
  }

  const rec = error as Record<string, unknown>
  const fields: ZxErrorFields = {}

  if (error instanceof Error) {
    fields.name = error.name
    fields.message = error.message
  } else if (typeof rec.message === 'string') {
    fields.message = rec.message
  }

  const exitCode = rec.exitCode

  if (typeof exitCode === 'number' || exitCode === null) fields.exitCode = exitCode

  const stderr = readTrimmedString(rec.stderr, STDERR_EXCERPT_MAX_BYTES)

  if (stderr) fields.stderr = stderr

  const stdout = readTrimmedString(rec.stdout, STDOUT_EXCERPT_MAX_BYTES)

  if (stdout) fields.stdout = stdout

  return fields
}
