import checkbox from '@inquirer/checkbox'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import yaml from 'yaml'
import { z } from 'zod'
import { $ } from 'zx'

import { commandEcho } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { pickEnv } from 'src/lib/prompts/env-picker'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { confirmDeploy, resolveDeployBranch } from 'src/lib/release-deploy'
import { releaseLabelFromBranch } from 'src/lib/release-utils'
import {
  assertDeployable,
  deployableEnvs,
  readWorkflowEnvOptions,
  resolveProtectedEnvAccess,
  warnProtectedEnvDispatch,
} from 'src/lib/workflow-envs'
import { defineMcpTool, textContent } from 'src/types'

/** The workflow this command dispatches. Its own inputs are both the env list and the service list. */
const DEPLOY_SELECTED_WORKFLOW = 'deploy-selected-services.yml'

/** A `workflow_dispatch` boolean that is a flag, not a service — the one exclusion from the service list. */
const SKIP_TERRAFORM_INPUT = 'skip_terraform_deploy'

interface GhReleaseDeploySelectedArgs {
  /** Optional on the CLI — omitted means "offer the open release PRs". The MCP schema requires it. */
  version?: string
  /** Optional on the CLI — omitted means "offer the workflow's own environments". The MCP schema requires it. */
  env?: string
  /** Optional on the CLI — omitted opens the service checkbox. The MCP schema requires it. */
  services?: string[]
  skipTerraform?: boolean
  confirmedCommand?: boolean
}

/**
 * Deploy selected services from a release branch to an environment
 */
export const ghReleaseDeploySelected = async (args: GhReleaseDeploySelectedArgs) => {
  const { version, env, services, skipTerraform, confirmedCommand } = args

  const selectedReleaseBranch = await resolveDeployBranch(version)

  const selectedVersion = releaseLabelFromBranch(selectedReleaseBranch)

  commandEcho.addOption('--version', selectedVersion)

  // This workflow's own `environment` choices, minus the delivery-only ones. Read PER WORKFLOW, not once
  // per repo: travelist's `deploy-all.yml` and `deploy-selected-services.yml` genuinely declare different
  // environments, so a single repo-level list could only ever be wrong for one of them — as the old
  // `environments` array was.
  const protectedEnvAccess = await resolveProtectedEnvAccess()
  const envOptions = deployableEnvs(await readWorkflowEnvOptions(DEPLOY_SELECTED_WORKFLOW), protectedEnvAccess)

  let selectedEnv = ''

  if (env) {
    selectedEnv = env
  } else {
    commandEcho.setInteractive()

    selectedEnv = await pickEnv(envOptions, 'launch deploy-selected workflow')
  }

  commandEcho.addOption('--env', selectedEnv)

  // `prod` is delivered, not deployed ad-hoc — see gh-release-deliver — unless this project's
  // `protectedEnvs` says otherwise. The one rule GitHub cannot enforce for us.
  assertDeployable(selectedEnv, 'launch deploy-selected workflow', protectedEnvAccess)

  // Allowed, but nothing downstream re-checks it on this path: GitHub holds the credentials and no job
  // declares `environment:`. The guidance the refusal used to carry is emitted here instead.
  warnProtectedEnvDispatch({ env: selectedEnv, branch: selectedReleaseBranch })

  // Available services, from the same workflow's boolean inputs. Unlike the env list this one is still
  // enforced below — a `choice` value is validated by GitHub, but an undeclared `-f <service>=true` is
  // NOT known to be rejected, and a typo that GitHub shrugs at would dispatch a run that deploys
  // nothing and reports success. Until that is proven otherwise, the local check stays.
  const availableServices = await parseServicesFromWorkflow()

  // Genuinely fatal for THIS command — there is nothing to pick from. (The failure it replaces was an
  // uncaught ENOENT from `fs.readFile`, which is how a repo with no such workflow, like bridge, used to
  // die here with a raw stack trace instead of a sentence.)
  if (availableServices.length === 0) {
    throw new OperationError(undefined, {
      operation: 'launch deploy-selected workflow',
      remediation: `declare boolean service inputs in .github/workflows/${DEPLOY_SELECTED_WORKFLOW}`,
      stderrExcerpt: `no services found in .github/workflows/${DEPLOY_SELECTED_WORKFLOW}`,
    })
  }

  let selectedServices: string[] = []

  if (services && services.length > 0) {
    selectedServices = services
  } else {
    commandEcho.setInteractive()

    selectedServices = await withEscape((context) => {
      return checkbox(
        {
          message: '🚀 Select services to deploy (space to select, enter to confirm)',
          choices: availableServices.map((svc) => {
            return {
              name: svc,
              value: svc,
            }
          }),
        },
        context,
      )
    })
  }

  commandEcho.addOption('--services', selectedServices)

  if (selectedServices.length === 0) {
    throw new OperationError(undefined, {
      operation: 'launch deploy-selected workflow',
      remediation: `pass at least one service from: ${availableServices.join(', ')}`,
      stderrExcerpt: 'no services selected',
    })
  }

  // Validate all selected services
  const invalidServices = selectedServices.filter((svc) => {
    return !availableServices.includes(svc)
  })

  if (invalidServices.length > 0) {
    throw new OperationError(undefined, {
      operation: 'launch deploy-selected workflow',
      remediation: `pass services from: ${availableServices.join(', ')}`,
      stderrExcerpt: `invalid services: ${invalidServices.join(', ')}`,
    })
  }

  const shouldSkipTerraform = skipTerraform ?? false

  if (shouldSkipTerraform) {
    commandEcho.addOption('--skip-terraform', true)
  }

  const buildResult = (success: boolean) => {
    const structuredContent = {
      releaseBranch: selectedReleaseBranch,
      version: selectedVersion,
      environment: selectedEnv,
      services: selectedServices,
      skipTerraformDeploy: shouldSkipTerraform,
      success,
    }

    return {
      content: textContent(JSON.stringify(structuredContent, null, 2)),
      structuredContent,
    }
  }

  if (!(await confirmDeploy({ confirmedCommand, branch: selectedReleaseBranch, env: selectedEnv }))) {
    logger.info('Deployment cancelled')

    return buildResult(false)
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

    return buildResult(true)
  } catch (error: unknown) {
    logger.error({ error }, '❌ Error launching workflow')
    throw new OperationError(error, {
      operation: 'launch deploy-selected workflow',
      remediation: "check 'gh workflow list' and that deploy-selected-services.yml exists on the target ref",
    })
  }
}

/**
 * The services this workflow can deploy: its `workflow_dispatch` boolean inputs, minus the flags that
 * are not services.
 *
 * Returns `[]` rather than throwing when the workflow is missing or unreadable — the caller turns that
 * into a sentence. Previously an absent file (bridge has no `deploy-selected-services.yml`) escaped as
 * a raw `ENOENT` from `fs.readFile`, and a workflow with no `workflow_dispatch` as a `TypeError` on
 * `parsed.on.workflow_dispatch`.
 *
 * @example
 * await parseServicesFromWorkflow() // => ['client-be', 'client-fe']
 * // no such workflow => []
 */
const parseServicesFromWorkflow = async (): Promise<string[]> => {
  const projectRoot = await getProjectRoot()

  const workflowPath = resolve(projectRoot, '.github/workflows', DEPLOY_SELECTED_WORKFLOW)

  let parsed: unknown

  try {
    parsed = yaml.parse(await fs.readFile(workflowPath, 'utf-8'))
  } catch {
    return []
  }

  const on = (parsed as { on?: unknown } | null)?.on
  const inputs = (on as { workflow_dispatch?: { inputs?: unknown } } | undefined)?.workflow_dispatch?.inputs

  if (typeof inputs !== 'object' || inputs === null) return []

  return Object.entries(inputs)
    .filter(([key, value]) => {
      return (value as { type?: string } | null)?.type === 'boolean' && key !== SKIP_TERRAFORM_INPUT
    })
    .map(([key]) => {
      return key
    })
}

// MCP Tool Registration
export const ghReleaseDeploySelectedMcpTool = defineMcpTool({
  name: 'gh-release-deploy-selected',
  requiresHumanConfirm: true,
  description:
    'Dispatch the deploy-selected-services.yml GitHub Actions workflow to deploy a chosen subset of services from a release branch to the given environment. Fire-and-forget — returns once GitHub accepts the workflow_dispatch, NOT when the deployment finishes; watch the workflow run for completion status. Service names are validated against the boolean inputs declared in the workflow. Use gh-release-deploy-all for every service. "version", "env", and "services" are all required when invoked via MCP (interactive pickers are unavailable without a TTY).',
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
    services: z
      .array(z.string())
      .describe(
        'Service names to deploy. Each must match a boolean input declared in .github/workflows/deploy-selected-services.yml (e.g. "client-be", "client-fe"). Required for MCP calls.',
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
    services: z.array(z.string()).describe('The services that were deployed'),
    skipTerraformDeploy: z.boolean().describe('Whether terraform deployment was skipped'),
    success: z.boolean().describe('Whether the deployment was successful'),
  },
  handler: ghReleaseDeploySelected,
})
