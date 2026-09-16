/**
 * @fileoverview
 * Shared interactive-confirmation gate for mutating commands.
 *
 * When `confirmedCommand` is truthy (`--yes`, the argv a `confirmation_required`
 * refusal hands back) the prompt is skipped and execution proceeds. Otherwise, with no human to ask — agent mode, or `--json`, whose
 * stdout a machine is parsing — it throws a `confirmation_required` refusal
 * carrying the argv that confirms (preview-then-execute, no new flag). Otherwise
 * it prompts the user, marks the echo as interactive, and exits cleanly if the
 * user declines.
 *
 * Esc aborts the prompt (via `withEscape`) rather than answering it — the caller
 * sees an `AbortPromptError`, which every command's boundary already treats as a
 * clean back-out through `isPromptCancellation`. That is deliberately NOT the same
 * as declining: a decline is an answer of "no" and takes the `process.exit(0)` path
 * below, whereas Esc means "I never answered".
 *
 * Unlike every other prompt in the CLI this one renders to STDOUT, not stderr —
 * left as-is, since changing it would move confirmation text out of the stream
 * callers have always read it from.
 *
 * The `process.exit(0)` only runs on the interactive-decline path: headless
 * callers refuse above it, so a `--json` document is never cut short by it.
 *
 * Callers remain responsible for their own `commandEcho.addOption('--yes', …)`
 * bookkeeping, which varies between commands.
 */
import confirm from '@inquirer/confirm'
import process from 'node:process'

import { agentMode, isHeadless } from 'src/lib/agent-mode'
import { CommandDeclinedError } from 'src/lib/errors/command-declined-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { logger } from 'src/lib/logger'
import { rerunArgv } from 'src/lib/parsed-argv'
import { withEscape } from 'src/lib/prompts/escapable-context'

import { commandEcho } from './command-echo'

export interface ConfirmOrExitOptions {
  /**
   * The structured form of what `message` renders, handed back verbatim in the
   * `confirmation_required` payload so an agent can show the human WHAT it is
   * about to confirm without parsing prose. JSON-safe and secret-free — it is
   * emitted to stdout. Sites with no structured plan pass nothing.
   */
  plan?: unknown
  /**
   * Throw {@link CommandDeclinedError} on a decline instead of `process.exit(0)`.
   *
   * **Defaults to false, and must stay that way.** Seven commands call this
   * helper; flipping the default would change the exit semantics of all of them
   * at once, inside a change whose tests cover none of them.
   *
   * Opt in when the command has already acquired something that needs releasing
   * by the time it prompts — `process.exit` skips every `finally`, so for those
   * commands the decline path is precisely where a resource leaks. The caller
   * owns catching it and exiting 0: a decline is a successful outcome.
   */
  throwOnDecline?: boolean
}

/**
 * Throw the `confirmation_required` refusal an agent (or a `--json` run) gets in place of a confirm
 * prompt: the message, the site's plan, the argv that confirms, and the source. Exit 2 — nothing ran.
 *
 * Exported for the one confirm site that is not `confirmOrExit` (`lib/release-deploy/confirm-deploy`),
 * so both speak the same shape.
 */
// Thrown from HERE, not from `withEscape`'s headless branch, because it needs what only a confirm
// site has: the message, the plan, and the knowledge that `--yes` is the answer. Callers key it on
// `isHeadless()`, never on `confirmedCommand`, so their `--yes` short-circuit stays as it was for
// agent and human alike.
export const refuseUnconfirmed = (message: string, plan?: unknown): never => {
  const { source } = agentMode
  const rerun = rerunArgv()

  throw new StructuredRefusalError({ status: 'confirmation_required', message, plan, rerun, agentMode: source }, 2, {
    operation: 'confirm before running',
    remediation:
      source === null
        ? 'pass `--yes` to confirm, or drop `--json` to be prompted'
        : `show the plan to the human, then re-run \`infra-kit ${rerun.join(' ')}\` to confirm`,
    stderrExcerpt: 'confirmation required and nobody to ask',
  })
}

export const confirmOrExit = async (
  confirmedCommand: boolean | undefined,
  message: string,
  options: ConfirmOrExitOptions = {},
): Promise<void> => {
  if (!confirmedCommand && isHeadless()) refuseUnconfirmed(message, options.plan)

  const answer = confirmedCommand
    ? true
    : await withEscape(
        (context) => {
          return confirm({ message }, context)
        },
        // Unreachable headless: the guard above already refused every agent / `--json` run that got
        // here without `confirmedCommand`. Written out anyway — G7 requires every reachable site to
        // answer, and `'refuse'` is the answer that costs nothing if the guard above ever moves.
        { whenHeadless: 'refuse' },
      )

  if (!confirmedCommand) {
    commandEcho.setInteractive()
  }

  if (!answer) {
    if (options.throwOnDecline) {
      throw new CommandDeclinedError()
    }

    logger.info('Operation cancelled. Exiting...')
    process.exit(0)
  }
}
