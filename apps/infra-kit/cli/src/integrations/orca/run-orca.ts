import { $ } from 'zx'

import { logger } from 'src/lib/logger'

/**
 * The only place that spawns `orca`. Everything the driver knows about the CLI is
 * encoded here:
 *
 * - infra-kit owns git; Orca owns windows. The `orca worktree` subcommand's
 *   `create` and `rm` verbs are forbidden in this codebase — `rm` also deletes the
 *   local branch, and `create` picks paths/branch names infra-kit's worktree
 *   layout does not control (docs/orca-migration-plan.md §1, principle 1).
 * - The JSON envelope is the contract, never the exit code: `ok:false` came back
 *   with exit 0 on 1.4.203 and exit 1 on 1.4.204, and the app auto-updates
 *   unattended (docs/orca-cli-findings.md, "Additional facts").
 */

export interface OrcaErrorPayload {
  code: string
  message: string
  data?: unknown
}

interface OrcaEnvelope<T> {
  ok: boolean
  result?: T
  error?: OrcaErrorPayload
}

/** Orca answered with `{ ok: false, error }`. */
export class OrcaError extends Error {
  readonly code: string
  readonly data: unknown

  constructor(payload: OrcaErrorPayload) {
    super(payload.message)
    this.name = 'OrcaError'
    this.code = payload.code
    this.data = payload.data
  }
}

/** Orca ran but stdout was not an envelope — a crash, a `--help` fallback, or a CLI too old for `--json`. */
export class OrcaMalformedError extends Error {
  readonly exitCode: number | null
  readonly stderrTail: string

  constructor(exitCode: number | null, stderrTail: string) {
    super(`orca: stdout is not a JSON envelope (exit ${exitCode ?? 'signal'})`)
    this.name = 'OrcaMalformedError'
    this.exitCode = exitCode
    this.stderrTail = stderrTail
  }
}

/** The `orca` binary is not on PATH (spawn ENOENT, or the shell's exit 127). */
export class OrcaAbsentError extends Error {
  constructor() {
    super('orca: command not found — the CLI is registered from Orca → Settings → Experimental → CLI')
    this.name = 'OrcaAbsentError'
  }
}

const STDERR_TAIL_CHARS = 400
const SHELL_COMMAND_NOT_FOUND = 127

interface SpawnOutput {
  exitCode: number | null
  stdout: string
  stderr: string
}

const isEnoent = (error: unknown): boolean => {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

const spawnOrca = async (argv: string[]): Promise<SpawnOutput> => {
  try {
    // zx runs through a shell, so a missing binary normally surfaces as exit 127 rather than a
    // rejection; the catch covers the shell-less spawn failure shape.
    return await $({ nothrow: true, quiet: true })`orca ${argv} --json`
  } catch (error) {
    if (isEnoent(error)) {
      throw new OrcaAbsentError()
    }

    throw error
  }
}

const parseEnvelope = <T>(stdout: string): OrcaEnvelope<T> | null => {
  try {
    const parsed: unknown = JSON.parse(stdout)

    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { ok?: unknown }).ok === 'boolean') {
      return parsed as OrcaEnvelope<T>
    }

    return null
  } catch {
    return null
  }
}

/**
 * Run one `orca` command and return its `result`. Throws {@link OrcaError} on an
 * `ok:false` envelope, {@link OrcaMalformedError} when stdout is not an envelope,
 * and {@link OrcaAbsentError} when the binary is missing — regardless of exit code.
 */
export const runOrca = async <T>(argv: string[]): Promise<T> => {
  const output = await spawnOrca(argv)
  const envelope = parseEnvelope<T>(output.stdout)

  logger.debug({ argv, ok: envelope?.ok, code: envelope?.error?.code, exitCode: output.exitCode }, 'orca')

  if (!envelope) {
    if (output.exitCode === SHELL_COMMAND_NOT_FOUND) {
      throw new OrcaAbsentError()
    }

    throw new OrcaMalformedError(output.exitCode, output.stderr.slice(-STDERR_TAIL_CHARS))
  }

  if (!envelope.ok) {
    throw new OrcaError(envelope.error ?? { code: 'unknown', message: 'orca: ok:false without an error payload' })
  }

  return envelope.result as T
}
