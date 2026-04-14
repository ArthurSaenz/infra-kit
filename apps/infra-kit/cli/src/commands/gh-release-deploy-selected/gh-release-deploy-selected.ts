import checkbox from '@inquirer/checkbox'
import select from '@inquirer/select'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import yaml from 'yaml'
import { z } from 'zod'
import { $ } from 'zx'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { commandEcho } from 'src/lib/command-echo'
import { ENVs } from 'src/lib/constants'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { detectReleaseType, formatBranchChoices, getJiraDescriptions } from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import type { ToolsExecutionResult } from 'src/types'

interface GhReleaseDeploySelectedArgs {
  version: string
  env: string
  services: string[]
  skipTerraform?: boolean
}

/**
 * Deploy selected services from a release branch to an environment
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
export const ghReleaseDeploySelected = async (args: GhReleaseDeploySelectedArgs): Promise<ToolsExecutionResult> => {
  const { version, env, services, skipTerraform } = args

  commandEcho.start('release-deploy-selected')

  let selectedReleaseBranch = ''

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

  // Parse available services from workflow file
  const availableServices = await parseServicesFromWorkflow()

  if (availableServices.length === 0) {
    logger.error('❌ No services found in workflow file. Exiting...')

    process.exit(1)
  }

  let selectedServices: string[] = []

  if (services && services.length > 0) {
    selectedServices = services
  } else {
    commandEcho.setInteractive()

    selectedServices = await checkbox({
      message: '🚀 Select services to deploy (space to select, enter to confirm)',
      choices: availableServices.map((svc) => {
        return {
          name: svc,
          value: svc,
        }
      }),
    })
  }

  commandEcho.addOption('--services', selectedServices)

  if (selectedServices.length === 0) {
    logger.error('❌ No services selected. Exiting...')
    process.exit(1)
  }

  // Validate all selected services
  const invalidServices = selectedServices.filter((svc) => {
    return !availableServices.includes(svc)
  })

  if (invalidServices.length > 0) {
    logger.error(
      `❌ Invalid services: ${invalidServices.join(', ')}. Available services: ${availableServices.join(', ')}`,
    )
    process.exit(1)
  }

  const shouldSkipTerraform = skipTerraform ?? false

  if (shouldSkipTerraform) {
    commandEcho.addOption('--skip-terraform', true)
  }

  try {
    $.quiet = true

    // Build the workflow command with boolean flags for each selected service
    const serviceFlags = selectedServices.flatMap((svc) => {
      return ['-f', `${svc}=true`]
    })
    const skipTerraformFlag = shouldSkipTerraform ? ['-f', 'skip_terraform_deploy=true'] : []

    await $`gh workflow run deploy-selected-services.yml --ref ${selectedReleaseBranch} -f environment=${selectedEnv} ${serviceFlags} ${skipTerraformFlag}`

    $.quiet = false

    logger.info(
      `Successfully launched deploy-selected-services workflow_dispatch for release branch: ${selectedReleaseBranch}, environment: ${selectedEnv}, services: ${selectedServices.join(', ')}`,
    )

    commandEcho.print()

    const structuredContent = {
      releaseBranch: selectedReleaseBranch,
      version: selectedReleaseBranch.replace('release/v', ''),
      environment: selectedEnv,
      services: selectedServices,
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

/**
 * Parse available services from the workflow file
 * Services are defined as boolean inputs (excluding skip_terraform_deploy)
 */
const parseServicesFromWorkflow = async (): Promise<string[]> => {
  const projectRoot = await getProjectRoot()

  const workflowPath = resolve(projectRoot, '.github/workflows/deploy-selected-services.yml')

  const content = await fs.readFile(workflowPath, 'utf-8')
  const parsed = yaml.parse(content)

  const inputs = parsed.on.workflow_dispatch.inputs
  const services: string[] = []

  for (const [key, value] of Object.entries(inputs)) {
    // Filter for boolean type inputs, excluding non-service flags
    if ((value as { type: string }).type === 'boolean' && key !== 'skip_terraform_deploy') {
      services.push(key)
    }
  }

  return services
}

// MCP Tool Registration
export const ghReleaseDeploySelectedMcpTool = {
  name: 'gh-release-deploy-selected',
  description:
    'Dispatch the deploy-selected-services.yml GitHub Actions workflow to deploy a chosen subset of services from a release branch to the given environment. Fire-and-forget — returns once GitHub accepts the workflow_dispatch, NOT when the deployment finishes; watch the workflow run for completion status. Service names are validated against the boolean inputs declared in the workflow. Use gh-release-deploy-all for every service. "version", "env", and "services" are all required when invoked via MCP (interactive pickers are unavailable without a TTY).',
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
    services: z
      .array(z.string())
      .describe(
        'Service names to deploy. Each must match a boolean input declared in .github/workflows/deploy-selected-services.yml (e.g. "client-be", "client-fe"). Required for MCP calls.',
      ),
    skipTerraform: z.boolean().optional().describe('Skip the terraform deployment stage.'),
  },
  outputSchema: {
    releaseBranch: z.string().describe('The release branch that was deployed'),
    version: z.string().describe('The version that was deployed'),
    environment: z.string().describe('The environment deployed to'),
    services: z.array(z.string()).describe('The services that were deployed'),
    skipTerraformDeploy: z.boolean().describe('Whether terraform deployment was skipped'),
    success: z.boolean().describe('Whether the deployment was successful'),
  },
  handler: ghReleaseDeploySelected,
}
