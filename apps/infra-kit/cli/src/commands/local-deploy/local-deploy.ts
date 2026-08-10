import checkbox from '@inquirer/checkbox'
import confirm from '@inquirer/confirm'
import select from '@inquirer/select'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { z } from 'zod'
import { $ } from 'zx'

import { commandEcho } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { getCurrentBranch, getProjectRoot, getRepoName, isWorkingTreeClean } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { pickEnv } from 'src/lib/prompts/env-picker'
import { withEscape } from 'src/lib/prompts/escapable-context'
import {
  deployableEnvs,
  isProtectedEnv,
  readWorkflowEnvOptions,
  resolveProtectedEnvAccess,
} from 'src/lib/workflow-envs'
import { defineMcpTool, textContent } from 'src/types'

import { buildDeployEnv, contractRecord, formatContract } from './deploy-env'
import type { BuildEnvResult } from './deploy-env'
import { runPreflight } from './preflight'
import type { SkippableCheck } from './preflight'
import { discoverServices, eligibleServices, isEligible } from './service-discovery'
import type { DeployService } from './service-discovery'

/** The workflow whose `environment` choices seed the picker. Advisory only — `--env` always wins. */
const DEPLOY_ALL_WORKFLOW = 'deploy-all.yml'

/**
 * Environments the whole team shares. Everything else in the picker is somebody's personal account
 * (`arthur`, `renana`, …), where a dirty tree is the normal case rather than a hazard.
 */
const SHARED_ENVS = ['dev', 'stage']

/**
 * Whether this environment belongs to other people — the input to both the confirmation prompt and, via
 * `runPreflight`, the dirty-tree refusal.
 *
 * A delivery-shaped env is shared by definition, more so than `dev`, yet it is deliberately NOT in
 * {@link SHARED_ENVS}: until a project could reach `prod` at all the question never arose, because
 * `assertDeployable` refused first. Now that a project can allow it, resolving from the list alone
 * would hand production the WEAKER treatment of a personal environment — a y/N prompt and no clean-tree
 * check, i.e. shipping an uncommitted working tree to prod.
 *
 * Extracted rather than inlined so this resolution is testable. Asserting
 * `assertCleanTreeForSharedEnv({ isShared: true, … })` proves nothing about it: that hand-passes the
 * value under test and passes whether or not the bug exists.
 *
 * @example
 * isSharedEnv('dev')    // => true
 * isSharedEnv('prod')   // => true  — protected, therefore shared
 * isSharedEnv('arthur') // => false
 */
export const isSharedEnv = (env: string): boolean => {
  return SHARED_ENVS.includes(env) || isProtectedEnv(env)
}

/** Absolute, so the shell we run cannot be resolved from a caller-controlled PATH. */
const SHELL = '/bin/sh'

interface LocalDeployArgs {
  env?: string
  service?: string[]
  yes?: boolean
  dryRun?: boolean
  printEnv?: boolean
  skipPreflight?: string[]
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

  const selected = await withEscape((context) => {
    return checkbox({ message: `Deploy which services to ${env}?`, choices, pageSize: 20 }, context)
  })

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
    return withEscape((context) => {
      return confirm({ message: `Deploy ${count} service(s) to ${env} from this machine?`, default: false }, context)
    })
  }

  return withEscape((context) => {
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
  })
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
  const { env, service, yes, dryRun, printEnv, skipPreflight = [] } = args

  const projectRoot = await getProjectRoot()
  const project = await getRepoName()
  const services = await discoverServices(projectRoot)

  if (services.length === 0) {
    throw new OperationError(undefined, {
      operation: 'discover deployable services',
      remediation: 'run this from a repo that has devops/scripts/deploy-*.sh',
      stderrExcerpt: `no deploy scripts found under ${projectRoot}/devops/scripts`,
    })
  }

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
  const built = buildDeployEnv({ env: selectedEnv, branch, sha })

  if (printEnv) {
    logger.info(`Deploy contract for ${selectedEnv}:\n${formatContract(built)}`)
  }

  const skip = skipPreflight.filter((name): name is SkippableCheck => {
    return name === 'clean-tree' || name === 'toolchain'
  })

  const preflight = await runPreflight({
    env: selectedEnv,
    project,
    isShared,
    isClean: await isWorkingTreeClean(),
    runningEnvs: await runningCiEnvs(),
    skip,
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

  if (!yes && !(await confirmTarget({ env: selectedEnv, isShared, count: names.length }))) {
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
  env: z.string().describe('Target environment, e.g. "dev" or a personal env like "arthur". Required for MCP.'),
  dryRun: z.boolean().optional().describe('Resolve target, contract and commands without deploying.'),
  skipPreflight: z
    .array(z.enum(['clean-tree', 'toolchain']))
    .optional()
    .describe(
      'Waive a named non-critical check. The env/account and protected-env checks can never be waived, and clean-tree cannot be waived for a protected env.',
    ),
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

export const localDeployAllMcpTool = defineMcpTool({
  name: 'local-deploy-all',
  description: `Deploy EVERY service enabled for an environment, from this machine. ${SHARED_TOOL_NOTE}`,
  requiresHumanConfirm: true,
  inputSchema: sharedInput,
  outputSchema: sharedOutput,
  handler: localDeployAll,
})

export const localDeploySelectedMcpTool = defineMcpTool({
  name: 'local-deploy-selected',
  description: `Deploy a NAMED SUBSET of services from this machine. ${SHARED_TOOL_NOTE}`,
  requiresHumanConfirm: true,
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
