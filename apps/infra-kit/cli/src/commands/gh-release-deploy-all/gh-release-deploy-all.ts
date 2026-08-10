import confirm from '@inquirer/confirm'
import { z } from 'zod'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { commandEcho } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { logger } from 'src/lib/logger'
import { pickEnv } from 'src/lib/prompts/env-picker'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { pickReleaseBranch } from 'src/lib/prompts/release-picker'
import {
  detectReleaseType,
  formatBranchPickerItems,
  getJiraDescriptions,
  releaseLabelFromBranch,
  resolveReleaseBranch,
} from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import {
  assertDeployable,
  deployableEnvs,
  readWorkflowEnvOptions,
  resolveProtectedEnvAccess,
  warnProtectedEnvDispatch,
} from 'src/lib/workflow-envs'
import { defineMcpTool, textContent } from 'src/types'

/** The workflow this command dispatches. Its own `environment` choices are the env list. */
const DEPLOY_ALL_WORKFLOW = 'deploy-all.yml'

interface GhReleaseDeployAllArgs {
  version: string
  env: string
  skipTerraform?: boolean
  confirmedCommand?: boolean
}

interface ConfirmDeployArgs {
  confirmedCommand?: boolean
  branch: string
  env: string
}

/**
 * Gate the workflow dispatch behind an interactive confirmation. Returns true to
 * proceed; `confirmedCommand` (CLI `--yes`) skips the prompt. Mirrors the
 * confirm+commandEcho pattern used by worktrees-remove.
 */
const confirmDeploy = async (args: ConfirmDeployArgs): Promise<boolean> => {
  const { confirmedCommand, branch, env } = args

  if (confirmedCommand) return true

  commandEcho.setInteractive()

  const answer = await withEscape((context) => {
    return confirm({ message: `Deploy ${branch} → ${env}?`, default: false }, context)
  })

  if (answer) commandEcho.addOption('--yes', true)

  return answer
}

/**
 * Deploy a release branch to an environment
 */
export const ghReleaseDeployAll = async (args: GhReleaseDeployAllArgs) => {
  const { version, env, skipTerraform, confirmedCommand } = args

  let selectedReleaseBranch = '' // "release/v1.8.0" | "release/checkout-redesign" | "dev"

  if (version) {
    selectedReleaseBranch = version === 'dev' ? 'dev' : resolveReleaseBranch(version)
  } else {
    commandEcho.setInteractive()

    const releasePRsInfo = await getReleasePRsWithInfo()

    const branches = releasePRsInfo.map((pr) => {
      return pr.branch
    })

    const releaseTypes = new Map<string, ReleaseType>(
      releasePRsInfo.map((pr) => {
        return [pr.branch, detectReleaseType(pr.title)]
      }),
    )

    const descriptions = await getJiraDescriptions()

    selectedReleaseBranch = await pickReleaseBranch([
      { value: 'dev', label: 'dev' },
      ...formatBranchPickerItems({ branches, descriptions, types: releaseTypes }),
    ])
  }

  const selectedVersion = releaseLabelFromBranch(selectedReleaseBranch)

  commandEcho.addOption('--version', selectedVersion)

  // The workflow's own `environment` choices, minus the ones this project may not reach. This is
  // what `infra-kit.json → environments` used to hand-maintain in five copies: the same list, minus
  // `prod`, written out by hand and drifted (travelist's copy offered `roman` and `eliran`, whom its own
  // deploy-all.yml does not accept). Derived here from the three things that actually decide it — what
  // the workflow declares, what is delivery-shaped, and what this project's `protectedEnvs` says.
  const protectedEnvAccess = await resolveProtectedEnvAccess()
  const envOptions = deployableEnvs(await readWorkflowEnvOptions(DEPLOY_ALL_WORKFLOW), protectedEnvAccess)

  let selectedEnv = ''

  if (env) {
    selectedEnv = env
  } else {
    commandEcho.setInteractive()

    selectedEnv = await pickEnv(envOptions, 'launch deploy-all workflow')
  }

  commandEcho.addOption('--env', selectedEnv)

  // The one client-side veto: `prod` is delivered, not deployed ad-hoc — unless this project's
  // `protectedEnvs` says otherwise. GitHub cannot enforce either rule for us (from its side
  // `-f environment=prod` is a valid choice), so both are ours. Note what is NOT vetoed: an env absent
  // from the local YAML still dispatches, because this read is of the working tree while the run targets
  // `--ref <branch>`, and GitHub validates the choice itself.
  assertDeployable(selectedEnv, 'launch deploy-all workflow', protectedEnvAccess)

  // Allowed, but the reason it was ever blocked does not stop being true — and unlike the local path,
  // nothing downstream re-checks this one: GitHub holds the credentials and no job declares
  // `environment:`. So the guidance the refusal used to carry is emitted here instead.
  warnProtectedEnvDispatch({ env: selectedEnv, branch: selectedReleaseBranch })

  const shouldSkipTerraform = skipTerraform ?? false

  if (shouldSkipTerraform) {
    commandEcho.addOption('--skip-terraform', true)
  }

  if (!(await confirmDeploy({ confirmedCommand, branch: selectedReleaseBranch, env: selectedEnv }))) {
    logger.info('Deployment cancelled')

    const structuredContent = {
      releaseBranch: selectedReleaseBranch,
      version: selectedVersion,
      environment: selectedEnv,
      skipTerraformDeploy: shouldSkipTerraform,
      success: false,
    }

    return {
      content: textContent(JSON.stringify(structuredContent, null, 2)),
      structuredContent,
    }
  }

  try {
    $.quiet = true

    const skipTerraformFlag = shouldSkipTerraform ? ['-f', 'skip_terraform_deploy=true'] : []

    await $`gh workflow run deploy-all.yml --ref ${selectedReleaseBranch} -f environment=${selectedEnv} ${skipTerraformFlag}`

    $.quiet = false

    logger.info(
      `Successfully launched deploy-all workflow_dispatch for release branch: ${selectedReleaseBranch} and environment: ${selectedEnv}`,
    )

    commandEcho.print()

    const structuredContent = {
      releaseBranch: selectedReleaseBranch,
      version: selectedVersion,
      environment: selectedEnv,
      skipTerraformDeploy: shouldSkipTerraform,
      success: true,
    }

    return {
      content: textContent(JSON.stringify(structuredContent, null, 2)),
      structuredContent,
    }
  } catch (error: unknown) {
    logger.error({ error }, '❌ Error launching workflow')
    throw new OperationError(error, {
      operation: 'launch deploy-all workflow',
      remediation: "check 'gh workflow list' and that deploy-all.yml exists on the target ref",
    })
  }
}

// MCP Tool Registration
export const ghReleaseDeployAllMcpTool = defineMcpTool({
  name: 'gh-release-deploy-all',
  description:
    'Dispatch the deploy-all.yml GitHub Actions workflow to deploy every service from a release branch to the given environment. Fire-and-forget — returns once GitHub accepts the workflow_dispatch, NOT when the deployment finishes; watch the workflow run for completion status. Use gh-release-deploy-selected for a subset of services. Pass version="dev" to deploy from the dev branch instead of a release branch. Both "version" and "env" are required when invoked via MCP (interactive pickers are unavailable without a TTY).',
  requiresHumanConfirm: true,
  inputSchema: {
    version: z
      .string()
      .describe(
        'Accepts a release version (e.g. "1.2.5") OR a release name (e.g. "checkout-redesign") — resolves to the release/vX.Y.Z or release/<name> branch. Pass "dev" to deploy from the dev branch instead. Required for MCP calls.',
      ),
    env: z
      .string()
      .describe(
        'Target environment name — must match an env configured for the project (e.g. "dev", "renana", "oriana"). Required for MCP calls.',
      ),
    skipTerraform: z.boolean().optional().describe('Skip the terraform deployment stage.'),
    confirm: z
      .boolean()
      .optional()
      .describe('Set true to execute; omit for a dry-run gate that echoes the resolved action.'),
  },
  outputSchema: {
    releaseBranch: z.string().describe('The release branch that was deployed'),
    version: z.string().describe('The version that was deployed'),
    environment: z.string().describe('The environment deployed to'),
    skipTerraformDeploy: z.boolean().describe('Whether terraform deployment was skipped'),
    success: z.boolean().describe('Whether the deployment was successful'),
  },
  handler: ghReleaseDeployAll,
})
