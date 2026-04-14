import select from '@inquirer/select'
import process from 'node:process'
import { z } from 'zod'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { commandEcho } from 'src/lib/command-echo'
import { ENVs } from 'src/lib/constants'
import { logger } from 'src/lib/logger'
import { detectReleaseType, formatBranchChoices, getJiraDescriptions } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import type { ToolsExecutionResult } from 'src/types'

interface GhReleaseDeployAllArgs {
  version: string
  env: string
  skipTerraform?: boolean
}

/**
 * Deploy a release branch to an environment
 */
export const ghReleaseDeployAll = async (args: GhReleaseDeployAllArgs): Promise<ToolsExecutionResult> => {
  const { version, env, skipTerraform } = args

  commandEcho.start('release-deploy-all')

  let selectedReleaseBranch = '' // "release/v1.8.0"

  if (version) {
    selectedReleaseBranch = version === 'dev' ? 'dev' : `release/v${version}`
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

    selectedReleaseBranch = await select({
      message: '🌿 Select release branch',
      choices: [{ name: 'dev', value: 'dev' }, ...formatBranchChoices({ branches, descriptions, types: releaseTypes })],
    })
  }

  const selectedVersion = selectedReleaseBranch === 'dev' ? 'dev' : selectedReleaseBranch.replace('release/v', '')

  commandEcho.addOption('--version', selectedVersion)

  let selectedEnv = ''

  if (env) {
    selectedEnv = env
  } else {
    commandEcho.setInteractive()

    selectedEnv = await select({
      message: '🧪 Select environment',
      choices: ENVs.map((env) => {
        return {
          name: env,
          value: env,
        }
      }),
    })
  }

  commandEcho.addOption('--env', selectedEnv)

  if (!ENVs.includes(selectedEnv)) {
    logger.error(`❌ Invalid environment: ${selectedEnv}. Exiting...`)
    process.exit(1)
  }

  const shouldSkipTerraform = skipTerraform ?? false

  if (shouldSkipTerraform) {
    commandEcho.addOption('--skip-terraform', true)
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
      version: selectedReleaseBranch.replace('release/v', ''),
      environment: selectedEnv,
      skipTerraformDeploy: shouldSkipTerraform,
      success: true,
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
      structuredContent,
    }
  } catch (error: unknown) {
    logger.error({ error }, '❌ Error launching workflow')
    process.exit(1)
  }
}

// MCP Tool Registration
export const ghReleaseDeployAllMcpTool = {
  name: 'gh-release-deploy-all',
  description:
    'Dispatch the deploy-all.yml GitHub Actions workflow to deploy every service from a release branch to the given environment. Fire-and-forget — returns once GitHub accepts the workflow_dispatch, NOT when the deployment finishes; watch the workflow run for completion status. Use gh-release-deploy-selected for a subset of services. Pass version="dev" to deploy from the dev branch instead of a release branch. Both "version" and "env" are required when invoked via MCP (interactive pickers are unavailable without a TTY).',
  inputSchema: {
    version: z
      .string()
      .describe(
        'Release version to deploy from (e.g. "1.2.5") — resolves to the release/vX.Y.Z branch. Pass "dev" to deploy from the dev branch instead. Required for MCP calls.',
      ),
    env: z
      .string()
      .describe(
        'Target environment name — must match an env configured for the project (e.g. "dev", "renana", "oriana"). Required for MCP calls.',
      ),
    skipTerraform: z.boolean().optional().describe('Skip the terraform deployment stage.'),
  },
  outputSchema: {
    releaseBranch: z.string().describe('The release branch that was deployed'),
    version: z.string().describe('The version that was deployed'),
    environment: z.string().describe('The environment deployed to'),
    skipTerraformDeploy: z.boolean().describe('Whether terraform deployment was skipped'),
    success: z.boolean().describe('Whether the deployment was successful'),
  },
  handler: ghReleaseDeployAll,
}
