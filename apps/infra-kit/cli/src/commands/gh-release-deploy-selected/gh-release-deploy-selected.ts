import checkbox from '@inquirer/checkbox'
import { z } from 'zod'
import { $ } from 'zx'

import { commandEcho } from 'src/lib/command-echo'
import { createDeployFormProvider } from 'src/lib/deploy-form'
import { OperationError } from 'src/lib/errors/operation-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { pickEnv } from 'src/lib/prompts/env-picker'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { refuseMissingArguments } from 'src/lib/prompts/refuse-missing-arguments'
import { confirmDeploy, resolveDeployBranch } from 'src/lib/release-deploy'
import { releaseLabelFromBranch } from 'src/lib/release-utils'
import {
  assertDeployable,
  deployableEnvs,
  readWorkflowEnvOptions,
  resolveProtectedEnvAccess,
  warnProtectedEnvDispatch,
} from 'src/lib/workflow-envs'
import { readGatesFromWorkflow } from 'src/lib/workflow-gates'
import { parseServicesFromWorkflow } from 'src/lib/workflow-services'
import { defineMcpTool, textContent } from 'src/types'

/** The workflow this command dispatches. Its own inputs are both the env list and the service list. */
const DEPLOY_SELECTED_WORKFLOW = 'deploy-selected-services.yml'

interface GhReleaseDeploySelectedArgs {
  // All three used to be REQUIRED in the tool schema, and these comments used to say so. PR-1 relaxed
  // them to `.optional()` so an argument form could offer real values, because `narrowsArgs` only
  // lets a form add a key round 1 omitted. What replaced the required field as the guard is
  // `whenHeadless` at each picker below, not the schema.
  /** Omitted on the CLI offers the open release PRs; omitted under `--agent` lists them as `choices`. */
  version?: string
  /** Omitted on the CLI offers this workflow's own environments; under `--agent` they are the `choices`. */
  env?: string
  /** Omitted on the CLI opens the service checkbox; under `--agent` the declared services are the `choices`. */
  services?: string[]
  skipTerraform?: boolean
  confirmedCommand?: boolean
}

/**
 * Deploy selected services from a release branch to an environment
 */
// ONE provider instance for the tool definition and the agent-mode refusal, so an agent's `choices`
// are the form the schema describes.
const deploySelectedForm = createDeployFormProvider({
  workflowFile: DEPLOY_SELECTED_WORKFLOW,
  fields: ['version', 'env', 'services'],
  toolName: 'gh-release-deploy-selected',
})

export const ghReleaseDeploySelected = async (args: GhReleaseDeploySelectedArgs) => {
  const { version, env, services, skipTerraform, confirmedCommand } = args

  // Before any of the three pickers: one refusal lists every field round 1 omitted, and names the
  // first of them (the flags mirror the fields).
  await refuseMissingArguments({
    provider: deploySelectedForm,
    params: args,
    operation: 'launch deploy-selected workflow',
    argument: (offered) => {
      return offered[0] ?? 'version'
    },
  })

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
  const projectRoot = await getProjectRoot()

  const availableServices = await parseServicesFromWorkflow(projectRoot, DEPLOY_SELECTED_WORKFLOW)

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

    selectedServices = await withEscape(
      (context) => {
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
      },
      // Refuse is the ANSWER, not an oversight. This was `'unreachable'` while `services` was required;
      // PR-1 made it optional so the form could offer the declared service list, and G8 named the claim
      // false the moment it did.
      //
      // Refusing rather than answering: an empty or guessed service list is not a safe default — it
      // either deploys nothing while reporting success, or deploys something nobody picked. The form
      // supplies `services` for a client that can render one; anything else gets a clean refusal.
      { whenHeadless: 'refuse' },
    )
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

  // `workflow_dispatch.inputs` says a service CAN be asked for; the jobs' own `if:` says whether it
  // will RUN. Both consumer repos gate jobs by environment — `docs-fe` to dev plus the per-developer
  // envs, `mobile` to dev/prod — and dispatch is fire-and-forget, so without this check `mobile` to
  // `stage` is accepted by GitHub, skipped by the job, and reported here as `success: true`: a deploy
  // that shipped nothing. Refuse instead, after the env has resolved and before anything is sent.
  //
  // Scoped to THIS workflow, deliberately: the repo-wide union would import gates from files nobody
  // is dispatching (travelist's `media` is prod-only in `deploy-all.yml` and ungated here), turning a
  // legitimate `media` + `dev` run into a false refusal.
  //
  // Fail-open is also deliberate (`workflow-gates.ts`): a gate we cannot parse imposes no restriction,
  // so this closes the gates we measured and does not pretend to close every possible one.
  const gates = await readGatesFromWorkflow(projectRoot, DEPLOY_SELECTED_WORKFLOW)

  const gatedOut = selectedServices.filter((svc) => {
    const allowed = gates.get(svc)

    return allowed !== undefined && !allowed.includes(selectedEnv)
  })

  if (gatedOut.length > 0) {
    throw new OperationError(undefined, {
      operation: 'launch deploy-selected workflow',
      remediation: gatedOut
        .map((svc) => {
          return `${svc} deploys only to: ${(gates.get(svc) ?? []).join(', ')}`
        })
        .join('; '),
      stderrExcerpt: `${DEPLOY_SELECTED_WORKFLOW} gates these services out of ${selectedEnv}: ${gatedOut.join(', ')}`,
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

// MCP Tool Registration
export const ghReleaseDeploySelectedMcpTool = defineMcpTool({
  name: 'gh-release-deploy-selected',
  requiresHumanConfirm: true,
  // The only one of the four with a `services` field, and it reads a DIFFERENT workflow file than
  // `gh-release-deploy-all` — the consumer repos declare different environments in the two. The
  // provider offers `services` only when round 1 omitted it, because a form that changes the LENGTH
  // of an array the caller supplied is discarded whole by `narrowsArgs`.
  formProvider: deploySelectedForm,
  description:
    'Dispatch the deploy-selected-services.yml GitHub Actions workflow to deploy a chosen subset of services from a release branch to the given environment. Fire-and-forget — returns once GitHub accepts the workflow_dispatch, NOT when the deployment finishes; watch the workflow run for completion status. Service names are validated against the boolean inputs declared in the workflow, and a service the target environment gates out is refused BEFORE dispatch rather than dispatched and silently skipped. Use gh-release-deploy-all for every service. Omit any of "version", "env" or "services" and this server offers the human a form built from the real releases, environments and services; a client that cannot render one gets a refusal naming the missing field, never a guess.',
  inputSchema: {
    // All three `.optional()` for the same reason: `narrowsArgs` only lets a form ADD a key round 1
    // omitted, so a required field cannot be form-filled. `services` matters most — it is the one
    // the human actually wants to pick, and the one whose length the non-narrowing check would
    // otherwise discard in silence.
    version: z
      .string()
      .optional()
      .describe(
        'Accepts a release version (e.g. "1.2.5") OR a release name (e.g. "checkout-redesign") — resolves to the release/vX.Y.Z or release/<name> branch. Pass "dev" to deploy from the dev branch instead. Omit it to be offered the open releases.',
      ),
    env: z
      .string()
      .optional()
      .describe(
        'Target environment name — must match an env this project may reach (e.g. "dev", "renana", "oriana"). Omit it to be offered the environments deploy-selected-services.yml declares.',
      ),
    services: z
      .array(z.string())
      .optional()
      .describe(
        'Service names to deploy. Each must match a boolean input declared in .github/workflows/deploy-selected-services.yml (e.g. "client-be", "client-fe"). Some services are gated to particular environments by that workflow and are refused here rather than skipped by CI. Omit it to be offered the declared services.',
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
