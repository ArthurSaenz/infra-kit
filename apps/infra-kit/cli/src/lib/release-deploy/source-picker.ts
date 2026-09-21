import select from '@inquirer/select'
import process from 'node:process'

import { isHeadless } from 'src/lib/agent-mode'
import { withEscape } from 'src/lib/prompts/escapable-context'

import { DEPLOY_SOURCES } from './deploy-source'
import type { DeploySource } from './deploy-source'

/**
 * Whether `--from` may be asked for rather than demanded.
 *
 * Mirrors the gate in `prompts/release-picker`: `--agent` and `--json` runs must never render a prompt
 * into a structured stream, and a non-TTY run has nobody to answer it. In all three the missing `--from` has
 * to stay a hard error, which is what keeps the strict contract for scripts, `--yes` and CI.
 */
export const canPromptForDeploySource = (): boolean => {
  return !isHeadless() && process.stdin.isTTY === true
}

/** What each runner actually does, shown where the choice is made rather than buried in `--help`. */
const SOURCE_DESCRIPTIONS: Record<DeploySource, string> = {
  ci: 'Dispatch the GitHub workflow for a release ref',
  local: 'Run devops/scripts/deploy-*.sh here, against your current checkout',
}

/**
 * Ask where the deploy should run.
 *
 * This exists because the palette and session shell dispatch a command by its group path and NOTHING
 * else (`session/run-session.ts`) — no flags, ever. Every other consequential input on these commands
 * (`--version`, `--env`, `--services`) is optional-with-a-picker for exactly that reason; `--from` has
 * to be too, or picking a deploy from the palette is a row that fails the moment it is chosen.
 *
 * A picker is NOT a default: the choice is still stated on every invocation, just answered instead of
 * typed. The no-default property that the whole design rests on is untouched.
 */
export const pickDeploySource = async (): Promise<DeploySource> => {
  return withEscape(
    (context) => {
      return select(
        {
          message: '🚀 Where should this deploy run?',
          // TEMPORARILY DISABLED: `local` is filtered out while deploys run in CI only; the dispatcher
          // in `commands/release-deploy` refuses it too. Drop the filter to re-enable.
          choices: DEPLOY_SOURCES.filter((source) => {
            return source !== 'local'
          }).map((source) => {
            return { name: source, value: source, description: SOURCE_DESCRIPTIONS[source] }
          }),
        },
        context,
      )
    },
    // Refuse is the ANSWER, not an oversight: a headless run without `--from` must stay a hard error
    // (see `canPromptForDeploySource`), and only the merged `release-deploy` command calls this.
    { whenHeadless: 'refuse' },
  )
}
