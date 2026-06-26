import type { Command } from 'commander'
import process from 'node:process'

/**
 * `--json` output mode for the CLI. This is a presentation concern only: every
 * command handler already returns a `structuredContent` payload (the same one
 * the MCP surface consumes). Human/log output goes to stderr (see lib/logger),
 * so writing the structured payload to stdout never collides with it.
 */

export interface CommandResult {
  structuredContent?: unknown
}

/** Mutable holder (object so `prefer-const` holds while the flag toggles per run). */
export const jsonOutput = { enabled: false }

/**
 * In `--json` mode, write a command result's `structuredContent` to stdout as
 * pretty JSON and return the result unchanged. Outside `--json` mode it is a
 * no-op pass-through. The writer is injectable for testing.
 */
export const emit = <T extends CommandResult | void>(
  result: T,
  write: (text: string) => void = (text) => {
    process.stdout.write(text)
  },
): T => {
  if (jsonOutput.enabled && result && result.structuredContent != null) {
    write(`${JSON.stringify(result.structuredContent, null, 2)}\n`)
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

  cmd.commands.forEach(addJsonOption)
}
