import confirm from '@inquirer/confirm'

import { isHeadless } from 'src/lib/agent-mode'
import { commandEcho, refuseUnconfirmed } from 'src/lib/command-echo'
import { withEscape } from 'src/lib/prompts/escapable-context'

interface ConfirmDeployArgs {
  confirmedCommand?: boolean
  branch: string
  env: string
}

/**
 * Gate a workflow dispatch behind an interactive confirmation. Returns true to proceed;
 * `confirmedCommand` (CLI `--yes`) skips the prompt.
 *
 * The message names the RUNNER as well as the branch, because that is the one thing the command name
 * no longer carries: `release deploy-all` takes `--from ci|local`, so "which machine is about to build
 * and upload this" is a flag rather than a command name. Saying it here keeps the interactive path
 * honest about it. The local path has always named its runner (`local-deploy.ts`, "from this machine").
 *
 * SCOPE LIMIT — this is a courtesy for the interactive human, NOT a control. `--yes` returns early,
 * and every MCP call arrives with `confirmedCommand: true` already set by the tool handler, so no
 * MCP-initiated deploy ever sees this string. A Bash-driven agent without `--yes` gets the same
 * `confirmation_required` refusal `confirmOrExit` throws (the 9th confirm site speaks the shared
 * shape, plan `{ branch, env }`), and re-runs with `--yes` to dispatch.
 */
export const confirmDeploy = async (args: ConfirmDeployArgs): Promise<boolean> => {
  const { confirmedCommand, branch, env } = args

  if (confirmedCommand) return true

  const message = `Deploy ${branch} → ${env} via GitHub Actions?`

  if (isHeadless()) refuseUnconfirmed(message, { branch, env })

  commandEcho.setInteractive()

  const answer = await withEscape(
    (context) => {
      return confirm({ message, default: false }, context)
    },
    // Unreachable headless: the guard above already refused every agent / `--json` run without
    // `confirmedCommand`. Written out anyway — G7 requires every reachable site to answer.
    { whenHeadless: 'refuse' },
  )

  if (answer) commandEcho.addOption('--yes', true)

  return answer
}
