import checkbox from '@inquirer/checkbox'
import confirm from '@inquirer/confirm'
import select from '@inquirer/select'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { z } from 'zod'
import { $ } from 'zx'

import { commandEcho } from 'src/lib/command-echo'
import { createDeployFormProvider } from 'src/lib/deploy-form'
import { OperationError } from 'src/lib/errors/operation-error'
import { getCurrentBranch, getProjectRoot, isWorkingTreeClean } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { pickEnv } from 'src/lib/prompts/env-picker'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { deployableEnvs, isSharedEnv, readWorkflowEnvOptions, resolveProtectedEnvAccess } from 'src/lib/workflow-envs'
import { defineMcpTool, textContent } from 'src/types'

import { buildDeployEnv, contractRecord, formatContract } from './deploy-env'
import type { BuildEnvResult } from './deploy-env'
import { runPreflight } from './preflight'
import { discoverServices, eligibleServices, isEligible, resolveSsmPrefix } from './service-discovery'
import type { DeployService } from './service-discovery'

/** The workflow whose `environment` choices seed the picker. Advisory only — `--env` always wins. */
const DEPLOY_ALL_WORKFLOW = 'deploy-all.yml'

/** Absolute, so the shell we run cannot be resolved from a caller-controlled PATH. */
const SHELL = '/bin/sh'

interface LocalDeployArgs {
  env?: string
  service?: string[]
  /**
   * Consent already given — skip {@link confirmTarget}.
   *
   * The name is not cosmetic and must match `confirmDeploy`'s (`confirm-deploy.ts:27`): the MCP
   * chokepoint injects `confirmedCommand: true` into every handler call it lets through
   * (`tool-handler.ts:466`), and nothing injects `yes`. This field was previously spelled `yes`, so
   * on an MCP call it was `undefined`, `!yes` was true, and `confirmTarget` at the guard below
   * rendered an inquirer prompt into the JSON-RPC stream — `@inquirer` writes to `process.stdout`
   * (its `create-prompt.js` pipes to `context.output ?? process.stdout`, and no call site here
   * passes `output`), which under MCP stdio IS the transport. That is stream corruption, not a hang.
   * The CLI's `--yes` reaches this field through `release-deploy.ts`, exactly as it does for the two
   * `gh-release-deploy-*` commands.
   */
  confirmedCommand?: boolean
  dryRun?: boolean
  printEnv?: boolean
}

/** Environments with a CI deploy currently in flight, or `[]` when `gh` cannot answer. */
const runningCiEnvs = async (): Promise<string[]> => {
  const previousQuiet = $.quiet

  $.quiet = true

  try {
    const result = await $`gh run list --workflow=${DEPLOY_ALL_WORKFLOW} --status=in_progress --json displayTitle`
    const runs = JSON.parse(result.stdout) as { displayTitle?: string }[]

    // The workflow's `run-name` renders as `01 ⚙️ Deploy all [dev]`, so the env sits in brackets.
    return runs.flatMap((run) => {
      return /\[(?<env>[a-z0-9-]+)\]/.exec(run.displayTitle ?? '')?.groups?.env ?? []
    })
  } catch {
    // `gh` missing, unauthenticated, or no such workflow. This is a race guard, not a security
    // control — refusing to deploy because an optional tool is absent would be worse than the race.
    return []
  } finally {
    $.quiet = previousQuiet
  }
}

/** Ask which services to deploy, showing only those the chosen environment actually accepts. */
const pickServices = async (services: DeployService[], env: string): Promise<string[]> => {
  const choices = services.map((service) => {
    return { name: service.name, value: service.name }
  })

  const selected = await withEscape(
    (context) => {
      return checkbox({ message: `Deploy which services to ${env}?`, choices, pageSize: 20 }, context)
    },
    // MCP-unreachable: `service` is required (min 1) on local-deploy-selected; local-deploy-all takes the "all" branch.
    { whenHeadless: 'unreachable' },
  )

  if (selected.length === 0) {
    throw new OperationError(undefined, {
      operation: 'select services',
      remediation: 'pick at least one service, or use `local deploy-all`',
      stderrExcerpt: 'no services selected',
    })
  }

  return selected
}

/**
 * Confirm before touching a shared environment.
 *
 * Shared targets get an explicit two-option prompt defaulting to cancel rather than a y/N whose
 * default is one keystroke away: `dev` is everyone's, and a reflexive Enter is how it gets clobbered.
 */
const confirmTarget = async (args: { env: string; isShared: boolean; count: number }): Promise<boolean> => {
  const { env, isShared, count } = args

  if (!isShared) {
    return withEscape(
      (context) => {
        return confirm({ message: `Deploy ${count} service(s) to ${env} from this machine?`, default: false }, context)
      },
      // Refuse is the ANSWER, not an oversight: the caller gates this on `!confirmedCommand`, which the
      // MCP chokepoint always injects. That is a gate, not a schema fact, so it is no `'unreachable'` claim.
      { whenHeadless: 'refuse' },
    )
  }

  return withEscape(
    (context) => {
      return select(
        {
          message: `"${env}" is a SHARED environment — deploying ${count} service(s) from this machine. Continue?`,
          choices: [
            { name: 'No, cancel', value: false },
            { name: `Yes, deploy to ${env}`, value: true },
          ],
        },
        context,
      )
    },
    // Refuse is the ANSWER, not an oversight: the caller gates this on `!confirmedCommand`, which the
    // MCP chokepoint always injects. That is a gate, not a schema fact, so it is no `'unreachable'` claim.
    { whenHeadless: 'refuse' },
  )
}

/**
 * Run one deploy script with the resolved contract, streaming its output.
 *
 * `stdio: 'inherit'` rather than captured: these scripts run for minutes and echo their own
 * `COMMAND:` lines, and someone watching a deploy needs to see it happen, not a transcript after.
 */
const runDeployScript = (service: DeployService, childEnv: NodeJS.ProcessEnv, cwd: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    const child = spawn(SHELL, [service.scriptPath], { cwd, env: childEnv, stdio: 'inherit' })

    child.on('error', reject)
    child.on('close', (code) => {
      resolve(code ?? 1)
    })
  })
}

/**
 * Deploy each service in turn, stopping at the first failure.
 *
 * Sequential, not parallel: every script does `rm -rf ./out` in the repo root, so two at once would
 * delete each other's build. Stopping on failure avoids shipping a half-updated environment.
 */
const executeDeploys = async (args: {
  chosen: DeployService[]
  childEnv: NodeJS.ProcessEnv
  cwd: string
  env: string
}): Promise<{ deployed: string[]; failed: string[] }> => {
  const { chosen, childEnv, cwd, env } = args

  const deployed: string[] = []
  const failed: string[] = []

  for (const entry of chosen) {
    logger.info(`→ ${entry.name} → ${env}`)

    const code = await runDeployScript(entry, childEnv, cwd)

    if (code !== 0) {
      failed.push(entry.name)
      logger.error(`✗ ${entry.name} failed (exit ${code})`)
      break
    }

    deployed.push(entry.name)
    logger.info(`✓ ${entry.name}`)
  }

  return { deployed, failed }
}

/** Refuse names that do not exist, or that this environment will not accept. */
const assertServicesUsable = (args: { names: string[]; services: DeployService[]; env: string }): DeployService[] => {
  const { names, services, env } = args

  const known = new Map(
    services.map((entry) => {
      return [entry.name, entry]
    }),
  )

  const unknown = names.filter((name) => {
    return !known.has(name)
  })

  if (unknown.length > 0) {
    throw new OperationError(undefined, {
      operation: 'resolve the requested services',
      remediation: `known services: ${services
        .map((entry) => {
          return entry.name
        })
        .join(', ')}`,
      stderrExcerpt: `no deploy script for: ${unknown.join(', ')}`,
    })
  }

  // An explicitly named service the environment forbids is refused rather than silently skipped
  // inside the script — asking for it is a mistake worth surfacing, not absorbing.
  const forbidden = names.filter((name) => {
    const entry = known.get(name)

    return entry !== undefined && !isEligible(entry, env)
  })

  if (forbidden.length > 0) {
    throw new OperationError(undefined, {
      operation: `deploy to "${env}"`,
      remediation: 'drop those services, or deploy them to an environment they allow',
      stderrExcerpt: `not enabled for "${env}": ${forbidden.join(', ')} (the scripts would skip them)`,
    })
  }

  return names.map((name) => {
    return known.get(name) as DeployService
  })
}

/** Shape returned to both the CLI and MCP. */
const buildResult = (args: {
  env: string
  accountId: string
  names: string[]
  built: BuildEnvResult
  deployed: string[]
  failed: string[]
  dryRun: boolean
  success: boolean
}) => {
  const { env, accountId, names, built, deployed, failed, dryRun, success } = args

  const structuredContent = {
    environment: env,
    accountId,
    services: names,
    deployed,
    failed,
    contract: contractRecord(built.contract),
    strippedVars: built.stripped,
    dryRun,
    success,
  }

  return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
}

/** How the caller chose services — decides what the pickers ask, never what the gates allow. */
type Selection = 'all' | 'selected'

/**
 * Which service names this run targets.
 *
 * `deploy-all` takes everything the environment accepts; `deploy-selected` takes the `--service`
 * names, or asks when none were given. The eligibility filter has already been applied to
 * `eligible`, so "all" here means "all CI would deploy here", not "all on disk".
 */
const resolveNames = async (args: {
  selection: Selection
  eligible: DeployService[]
  service?: string[]
  env: string
}): Promise<string[]> => {
  const { selection, eligible, service, env } = args

  if (selection === 'all') {
    return eligible.map((entry) => {
      return entry.name
    })
  }

  if (service && service.length > 0) return service

  commandEcho.setInteractive()

  return pickServices(eligible, env)
}

/**
 * The shared body of `local deploy-all` and `local deploy-selected`.
 *
 * Both run the repo's own `devops/scripts/deploy-*.sh` — the same scripts CI runs — but supply the
 * build contract the workflow YAML normally provides, and refuse first when the target does not match
 * the AWS account the shell is pointed at. The only difference between the two commands is which
 * services they end up with; every gate applies identically.
 */
const runLocalDeploy = async (args: LocalDeployArgs, selection: Selection) => {
  const { env, service, confirmedCommand, dryRun, printEnv } = args

  const projectRoot = await getProjectRoot()
  const services = await discoverServices(projectRoot)

  if (services.length === 0) {
    throw new OperationError(undefined, {
      operation: 'discover deployable services',
      remediation: 'run this from a repo that has devops/scripts/deploy-*.sh',
      stderrExcerpt: `no deploy scripts found under ${projectRoot}/devops/scripts`,
    })
  }

  // After the no-scripts guard so that refusal keeps precedence, and before any picker so a
  // repo whose scripts cannot be preflighted is refused without first asking for a target.
  const project = resolveSsmPrefix(services)

  // Advisory only: `workflow-envs` reads the working tree while a dispatch targets a ref, and vetoing
  // against it once caused a real refuse-to-deploy bug. It seeds the picker; `--env` always wins.
  const protectedEnvAccess = await resolveProtectedEnvAccess()
  const envOptions = deployableEnvs(await readWorkflowEnvOptions(DEPLOY_ALL_WORKFLOW), protectedEnvAccess)

  let selectedEnv = env ?? ''

  if (!selectedEnv) {
    commandEcho.setInteractive()
    selectedEnv = await pickEnv(envOptions, 'deploy locally')
  }

  commandEcho.addOption('--env', selectedEnv)

  const eligible = eligibleServices(services, selectedEnv)

  if (eligible.length === 0) {
    throw new OperationError(undefined, {
      operation: `deploy to "${selectedEnv}"`,
      remediation: 'pick an environment these services allow',
      stderrExcerpt: `no service on disk is enabled for "${selectedEnv}"`,
    })
  }

  const names = await resolveNames({ selection, eligible, service, env: selectedEnv })
  const chosen = assertServicesUsable({ names, services, env: selectedEnv })

  if (selection === 'selected') {
    for (const name of names) {
      commandEcho.addOption('--service', name)
    }
  }

  const isShared = isSharedEnv(selectedEnv)
  const branch = await getCurrentBranch()
  const sha = (await $`git rev-parse HEAD`.quiet()).stdout.trim()
  // Resolved once and used twice — the contract label and the preflight gate must agree about the
  // tree, or a deploy could be refused as dirty while shipping a bundle labelled clean.
  const isClean = await isWorkingTreeClean()
  const built = buildDeployEnv({ env: selectedEnv, branch, sha, isClean })

  if (printEnv) {
    logger.info(`Deploy contract for ${selectedEnv}:\n${formatContract(built)}`)
  }

  const preflight = await runPreflight({
    env: selectedEnv,
    project,
    isShared,
    isClean,
    runningEnvs: await runningCiEnvs(),
    protectedEnvAccess,
  })

  const accountId = preflight.identity.accountId

  if (dryRun) {
    // Deliberately narrow: this rehearses the CLI layer — target, contract, and the exact commands.
    // It says nothing about whether the deploy itself would succeed, because the scripts are the
    // executor and their AWS calls are not simulated.
    logger.info(
      [
        `Would deploy to "${selectedEnv}" (AWS account ${accountId}) from this machine`,
        // Named so a run from a linked worktree can prove it probed the scripts' parameter, not one
        // derived from the checkout's directory name.
        `Preflight parameter: /${project}/environment`,
        formatContract(built),
        'Commands:',
        ...chosen.map((entry) => {
          return `  ${SHELL} ${entry.scriptPath}`
        }),
        '',
        'Dry run: preflight and contract only — says nothing about whether the deploy would succeed.',
      ].join('\n'),
    )

    return buildResult({
      env: selectedEnv,
      accountId,
      names,
      built,
      deployed: [],
      failed: [],
      dryRun: true,
      success: true,
    })
  }

  if (!confirmedCommand && !(await confirmTarget({ env: selectedEnv, isShared, count: names.length }))) {
    logger.info('Deployment cancelled')

    return buildResult({
      env: selectedEnv,
      accountId,
      names,
      built,
      deployed: [],
      failed: [],
      dryRun: false,
      success: false,
    })
  }

  if (built.stripped.length > 0) {
    logger.info(`Stripped ambient VITE_* from the build env: ${built.stripped.join(', ')}`)
  }

  const { deployed, failed } = await executeDeploys({
    chosen,
    childEnv: built.childEnv,
    cwd: projectRoot,
    env: selectedEnv,
  })

  if (failed.length > 0) {
    // No rollback exists here, and none exists in CI either. The honest remedy is redeploying the
    // previous commit, so name it rather than implying the environment is back to a known state.
    logger.error(
      `Partial deploy to "${selectedEnv}": succeeded [${deployed.join(', ') || 'none'}], failed [${failed.join(', ')}]. ` +
        `There is no rollback — redeploy the previous commit to restore it.`,
    )

    process.exitCode = 1
  }

  commandEcho.print()

  return buildResult({
    env: selectedEnv,
    accountId,
    names,
    built,
    deployed,
    failed,
    dryRun: false,
    success: failed.length === 0,
  })
}

/** Deploy every service this environment accepts, from this machine. */
export const localDeployAll = async (args: LocalDeployArgs) => {
  return runLocalDeploy(args, 'all')
}

/** Deploy a chosen subset of services from this machine. */
export const localDeploySelected = async (args: LocalDeployArgs) => {
  return runLocalDeploy(args, 'selected')
}

/** Shared by both tools — the local counterpart of what `deploy-all.yml` sets in its `env:` block. */
const SHARED_TOOL_NOTE =
  'Runs the repo\'s own devops/scripts/deploy-*.sh on THIS machine instead of dispatching CI. Supplies the build contract (VITE_DOMAIN_ENV/BRANCH/COMMIT) that the workflow YAML normally provides and that the scripts do not set themselves, and refuses unless the requested environment matches the AWS account the shell is authenticated to. "prod" is refused by default — it is delivered, not deployed — and is reachable only if this project sets `protectedEnvs` in infra-kit.json; "cli-only" allows it in a terminal but still refuses it here. Services the environment forbids are refused, matching the workflow\'s own per-service gates. Use dryRun first.'

const sharedInput = {
  // Shared by BOTH local tools, so this one `.optional()` relaxes `local-deploy-selected` too — which
  // is what lets an env form reach it. Its `service` stays required deliberately: a services picker
  // there needs an env-dependent domain (`eligibleServices`), which one round trip cannot supply.
  env: z
    .string()
    .optional()
    .describe(
      'Target environment, e.g. "dev" or a personal env like "arthur". Omit it to be offered the environments this project may reach.',
    ),
  dryRun: z.boolean().optional().describe('Resolve target, contract and commands without deploying.'),
  confirm: z.boolean().optional().describe('Set true to execute; omit for a dry-run gate.'),
}

const sharedOutput = {
  environment: z.string().describe('Environment deployed to'),
  accountId: z.string().describe('AWS account the deploy targeted'),
  services: z.array(z.string()).describe('Services requested'),
  deployed: z.array(z.string()).describe('Services that completed successfully'),
  failed: z.array(z.string()).describe('Services that failed'),
  contract: z.record(z.string(), z.string()).describe('Build contract passed to the scripts'),
  strippedVars: z.array(z.string()).describe('Ambient VITE_* names removed from the build env'),
  dryRun: z.boolean().describe('Whether this was a dry run'),
  success: z.boolean().describe('Whether every requested service deployed'),
}

/**
 * Both local tools get an `env`-only form, off the SAME `deploy-all.yml` the picker already reads.
 *
 * No `version`: neither tool has one — a local deploy builds the working tree. And no `services`
 * either, on `-selected` too: its `service` argument stays required because a services picker there
 * needs the env-dependent `eligibleServices` domain, which one round trip cannot supply — the env is
 * chosen in the same form. `toolName` differs so the `form options empty` log line names which tool
 * had nothing to offer.
 */
const localDeployForm = (toolName: string) => {
  return createDeployFormProvider({ workflowFile: DEPLOY_ALL_WORKFLOW, fields: ['env'], toolName })
}

export const localDeployAllMcpTool = defineMcpTool({
  name: 'local-deploy-all',
  description: `Deploy EVERY service enabled for an environment, from this machine. ${SHARED_TOOL_NOTE}`,
  requiresHumanConfirm: true,
  formProvider: localDeployForm('local-deploy-all'),
  inputSchema: sharedInput,
  outputSchema: sharedOutput,
  handler: localDeployAll,
})

export const localDeploySelectedMcpTool = defineMcpTool({
  name: 'local-deploy-selected',
  description: `Deploy a NAMED SUBSET of services from this machine. ${SHARED_TOOL_NOTE}`,
  requiresHumanConfirm: true,
  formProvider: localDeployForm('local-deploy-selected'),
  inputSchema: {
    ...sharedInput,
    service: z
      .array(z.string())
      .min(1)
      .describe('Service names as in devops/scripts/deploy-<name>.sh, e.g. ["client-be"]. Required for MCP.'),
  },
  outputSchema: sharedOutput,
  handler: localDeploySelected,
})
