import confirm from '@inquirer/confirm'

import { commandEcho } from 'src/lib/command-echo'
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
 * agent-initiated deploy ever sees this string. Nor is `--from` the control on that path: agents call
 * the `local-deploy-*` / `gh-release-deploy-*` tools directly and never traverse the merged command at
 * all. The only control an agent meets is `requiresHumanConfirm`'s two-phase gate.
 */
export const confirmDeploy = async (args: ConfirmDeployArgs): Promise<boolean> => {
  const { confirmedCommand, branch, env } = args

  if (confirmedCommand) return true

  commandEcho.setInteractive()

  const answer = await withEscape((context) => {
    return confirm({ message: `Deploy ${branch} → ${env} via GitHub Actions?`, default: false }, context)
  })

  if (answer) commandEcho.addOption('--yes', true)

  return answer
}
