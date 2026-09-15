/**
 * @fileoverview
 * Registration of the global `--agent` flag on the Commander tree.
 *
 * Registration only — the flag is READ by the `preAction` hook in program.ts, which feeds it to
 * `resolveAgentModeSource` (lib/agent-mode). It lives beside `debug-option.ts` for the same reason
 * that file gives: option registration is a Commander-surface concern.
 */
import type { Command } from 'commander'

/**
 * Register `--agent` on `cmd` and every subcommand beneath it.
 *
 * Recursive like `addJsonOption`: an option registered only on the root is not accepted after a
 * subcommand name, and every real invocation names one. Meant to be called on the ROOT, so a bare
 * `infra-kit --agent` parses too.
 */
export const addAgentOption = (cmd: Command): void => {
  const alreadyHasAgent = cmd.options.some((option) => {
    return option.long === '--agent'
  })

  if (!alreadyHasAgent) {
    cmd.option(
      '--agent',
      'Run as an agent: never prompt; refuse with a structured payload (under --json) naming what to pass instead',
    )
  }

  cmd.commands.forEach(addAgentOption)
}
