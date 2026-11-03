import type { Command } from 'commander'
import process from 'node:process'
import { z } from 'zod'

/**
 * `--json` output mode for the CLI. This is a presentation concern only: every
 * command handler already returns a `structuredContent` payload. Human/log
 * output goes to stderr (see lib/logger), so writing the structured payload to
 * stdout never collides with it.
 */

export interface CommandResult {
  structuredContent?: unknown
}

/**
 * The `--json` contract version. Adding a key is not a breaking change and does not bump it; renaming
 * or removing one, or changing a key's type, does.
 */
export const JSON_SCHEMA_VERSION = 1

/** The keys every `--json` document carries beside the command's own payload. */
export const jsonEnvelopeShape = {
  schemaVersion: z.literal(JSON_SCHEMA_VERSION),
  command: z.string().describe('The grouped command path that ran, e.g. `release create`'),
}

/**
 * Mutable holder (object so `prefer-const` holds while the flag toggles per run). `command` is set by
 * the program's preAction hook together with `enabled`, so a document is never written without it.
 */
export const jsonOutput = { enabled: false, command: '' }

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `payload` with the envelope merged in at the top level. Merged rather than wrapped (`{ result }`) so
 * every key a consumer already reads stays where it was; the payload spreads last, so a payload key can
 * never be shadowed by the envelope.
 *
 * @example
 * withEnvelope({ version: '1.2.3' }) // => { schemaVersion: 1, command: 'version', version: '1.2.3' }
 */
export const withEnvelope = (payload: unknown): unknown => {
  if (!isPlainObject(payload)) return payload

  return { schemaVersion: JSON_SCHEMA_VERSION, command: jsonOutput.command, ...payload }
}

/**
 * In `--json` mode, write a command result's `structuredContent` to stdout as
 * pretty JSON inside the envelope and return the result unchanged. Outside
 * `--json` mode it is a no-op pass-through. The writer is injectable for testing.
 */
export const emit = <T extends CommandResult | void>(
  result: T,
  write: (text: string) => void = (text) => {
    process.stdout.write(text)
  },
): T => {
  if (jsonOutput.enabled && result && result.structuredContent != null) {
    write(`${JSON.stringify(withEnvelope(result.structuredContent), null, 2)}\n`)
  }

  return result
}

/** Register `--json` on a command and every nested subcommand (idempotent). */
export const addJsonOption = (cmd: Command): void => {
  const alreadyHasJson = cmd.options.some((option) => {
    return option.long === '--json'
  })

  if (!alreadyHasJson) {
    cmd.option('--json', 'Output the structured result as JSON on stdout (human logs stay on stderr)')
  }

  for (const child of cmd.commands) {
    addJsonOption(child)
  }
}
