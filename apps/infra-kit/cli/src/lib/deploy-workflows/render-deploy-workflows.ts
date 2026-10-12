import type { DeployConfig, DeployService } from '@slip-stream-kit/config/internal'

/**
 * The shared per-service deploy job, pinned by commit: callers live in other orgs, where a moving ref
 * would let any push to this repo change what their deploys run. Bump it (and release) whenever
 * `.github/workflows/ik-deploy-service.yml` changes; `deploy-sync` then moves every consumer forward.
 */
export const SHARED_DEPLOY_JOB =
  'ArthurSaenz/infra-kit/.github/workflows/ik-deploy-service.yml@3f50266774b5dac9b7f8fe18f2dd652b692f33df'

/** GitHub refuses to dispatch a workflow with more inputs than this. */
const MAX_DISPATCH_INPUTS = 25

const SKIP_TERRAFORM_INPUT = 'skip_terraform_deploy'

type WorkflowKind = 'all' | 'selected'

/**
 * Named `-v2` and numbered 91/92 while the hand-written `deploy-all.yml` / `deploy-selected-services.yml`
 * still exist: the CLI's `release deploy-*` dispatches those by file name, and a v1 run and a v2 run
 * must share a concurrency group so they never deploy into one environment at once.
 */
const KINDS: Record<WorkflowKind, { file: string; title: string; concurrency: string; v1File: string }> = {
  all: {
    file: 'deploy-all-v2.yml',
    title: '91 🧪 Deploy all (v2)',
    concurrency: 'deploy-all',
    v1File: 'deploy-all.yml',
  },
  selected: {
    file: 'deploy-selected-v2.yml',
    title: '92 🧪 Deploy selected (v2)',
    concurrency: 'deploy-selected',
    v1File: 'deploy-selected-services.yml',
  },
}

export interface GeneratedWorkflow {
  /** Repo-relative path. */
  path: string
  content: string
}

interface PlannedService {
  name: string
  service: DeployService
  /** The offered environments it may deploy to; `undefined` = all of them, so no gate is emitted. */
  gate: string[] | undefined
}

/** `_terraform-apply-initUser-jobs.yml` → `terraform-apply-initUser`. */
const jobIdForWorkflow = (file: string): string => {
  return file.replace(/^_/, '').replace(/(?:-jobs)?\.ya?ml$/, '')
}

/** Services in manifest order, each with its env gate narrowed to the environments this workflow offers. */
const planServices = (config: DeployConfig, kind: WorkflowKind): PlannedService[] => {
  return Object.entries(config.services).flatMap(([name, service]) => {
    if (kind === 'all' && service.deployAll === false) return []

    if (service.envs === undefined) return [{ name, service, gate: undefined }]

    const allowed = config.environments.filter((env) => {
      return service.envs?.includes(env)
    })

    if (allowed.length === 0) return []

    return [{ name, service, gate: allowed.length === config.environments.length ? undefined : allowed }]
  })
}

/** A GitHub Actions expression, `${{ … }}`. */
const gh = (expression: string): string => {
  return `\${{ ${expression} }}`
}

/** A secret named after the dispatched environment, e.g. `arthur_AWS_REGION`, as v1 looks them up. */
const envSecret = (suffix: string): string => {
  return gh(`secrets[format('{0}_${suffix}', inputs.environment)]`)
}

const terraformOk = (terraformJobs: string[]): string[] => {
  return terraformJobs.map((job) => {
    return `(needs.${job}.result == 'success' || needs.${job}.result == 'skipped')`
  })
}

/**
 * The env gate is written as `contains(fromJSON(...), inputs.environment)` and never as
 * `inputs.environment == '<env>'`: the CLI's workflow-gates reader scans every workflow for the latter
 * and would start reading these files as another source of v1's gates.
 */
const serviceCondition = (planned: PlannedService, kind: WorkflowKind, terraformJobs: string[]): string | undefined => {
  const parts: string[] = []

  if (kind === 'selected') parts.push(`inputs.${planned.name}`)

  if (planned.gate !== undefined)
    parts.push(`contains(fromJSON('${JSON.stringify(planned.gate)}'), inputs.environment)`)

  if (terraformJobs.length > 0) parts.push('!cancelled()', ...terraformOk(terraformJobs))

  return parts.length === 0 ? undefined : gh(parts.join(' && '))
}

const needsLine = (jobs: string[]): string[] => {
  return jobs.length === 0 ? [] : [`    needs: [ ${jobs.join(', ')} ]`]
}

const ifLine = (condition: string | undefined): string[] => {
  return condition === undefined ? [] : [`    if: ${condition}`]
}

const localWorkflowCall = (file: string): string[] => {
  return [
    `    uses: ./.github/workflows/${file}`,
    '    with:',
    `      branch: ${gh('github.ref')}`,
    `      environment: ${gh('inputs.environment')}`,
    '    secrets: inherit',
  ]
}

const sharedJobCall = (planned: PlannedService, extraEnv: string[]): string[] => {
  const runner = planned.service.runner === undefined ? [] : [`      runner: ${planned.service.runner}`]
  const extra =
    extraEnv.length === 0
      ? []
      : [
          '      extra-env: |',
          ...extraEnv.map((secret) => {
            const value = gh(`secrets.${secret}`)

            return `        ${secret}=${value}`
          }),
        ]

  return [
    `    uses: ${SHARED_DEPLOY_JOB}`,
    '    with:',
    `      environment: ${gh('inputs.environment')}`,
    `      ref: ${gh('github.ref')}`,
    `      service: ${planned.name}`,
    ...runner,
    '    secrets:',
    `      aws-access-key-id: ${envSecret('AWS_ACCESS_KEY_ID')}`,
    `      aws-secret-access-key: ${envSecret('AWS_SECRET_ACCESS_KEY')}`,
    `      aws-region: ${envSecret('AWS_REGION')}`,
    `      serverless-access-key: ${gh('secrets.SERVERLESS_ACCESS_KEY')}`,
    `      slack-token: ${gh('secrets.SLACK_TOKEN')}`,
    `      slack-channel: ${gh('secrets.SLACK_CHANNEL')}`,
    ...extra,
  ]
}

const serviceJob = (
  planned: PlannedService,
  kind: WorkflowKind,
  terraformJobs: string[],
  extraEnv: string[],
): string[] => {
  const call =
    planned.service.workflow === undefined
      ? sharedJobCall(planned, extraEnv)
      : localWorkflowCall(planned.service.workflow)

  return [
    '',
    `  deploy-${planned.name}:`,
    ...needsLine(terraformJobs),
    ...ifLine(serviceCondition(planned, kind, terraformJobs)),
    ...call,
  ]
}

const booleanInput = (name: string, description: string): string[] => {
  return [
    '',
    `      ${name}:`,
    '        type: boolean',
    `        description: '${description}'`,
    '        required: false',
    '        default: false',
  ]
}

const dispatchInputs = (config: DeployConfig, kind: WorkflowKind, services: PlannedService[]): string[] => {
  const environment = [
    '      environment:',
    '        type: choice',
    "        description: 'Environment for deploy'",
    '        required: true',
    `        default: '${config.defaultEnvironment ?? config.environments[0]}'`,
    '        options:',
    ...config.environments.map((env) => {
      return `          - ${env}`
    }),
  ]
  const terraform =
    (config.terraform ?? []).length > 0 ? booleanInput(SKIP_TERRAFORM_INPUT, 'Skip terraform deployment') : []
  const perService =
    kind === 'all'
      ? []
      : services.flatMap((planned) => {
          const only = planned.gate === undefined ? '' : ` (${planned.gate.join(', ')} only)`

          return booleanInput(planned.name, `Deploy ${planned.name}${only}`)
        })

  return ['on:', '  workflow_dispatch:', '    inputs:', ...environment, ...terraform, ...perService]
}

const header = (config: DeployConfig, kind: WorkflowKind): string[] => {
  const { title, concurrency, v1File } = KINDS[kind]
  const skipTf =
    (config.terraform ?? []).length > 0 ? gh(`inputs.${SKIP_TERRAFORM_INPUT} && '' — skip TF'' || ''''`) : ''

  return [
    '# Generated by `infra-kit deploy-sync` from infra-kit.deploy.ts: edit that file and re-run the command,',
    '# a hand edit here is overwritten.',
    `name: '${title}'`,
    `run-name: '${title} [${gh('inputs.environment')}]${skipTf}'`,
    '',
    `# Same group as ${v1File}, so a v1 run and a v2 run never deploy into one environment at once.`,
    'concurrency:',
    `  group: ${concurrency}-${gh('inputs.environment')}`,
    '  # false: a cancelled run would also kill an in-flight terraform apply.',
    '  cancel-in-progress: false',
    '',
  ]
}

const terraformJob = (file: string): string[] => {
  const unlessSkipped = gh(`!inputs.${SKIP_TERRAFORM_INPUT}`)

  return ['', `  ${jobIdForWorkflow(file)}:`, `    if: ${unlessSkipped}`, ...localWorkflowCall(file)]
}

const notifyJob = (file: string, deployJobs: string[]): string[] => {
  return [
    '',
    '  notify-success:',
    ...needsLine(deployJobs),
    `    if: ${gh("!cancelled() && contains(needs.*.result, 'success') && !contains(needs.*.result, 'failure')")}`,
    `    uses: ./.github/workflows/${file}`,
    '    secrets: inherit',
  ]
}

const renderWorkflow = (config: DeployConfig, kind: WorkflowKind): GeneratedWorkflow => {
  const services = planServices(config, kind)
  const terraformFiles = config.terraform ?? []
  const terraformJobs = terraformFiles.map(jobIdForWorkflow)
  const inputCount = 1 + (terraformFiles.length > 0 ? 1 : 0) + (kind === 'selected' ? services.length : 0)

  if (inputCount > MAX_DISPATCH_INPUTS) {
    throw new Error(
      `${KINDS[kind].file} would need ${inputCount} dispatch inputs; GitHub allows ${MAX_DISPATCH_INPUTS}. Mark services \`deployAll: false\` or split them.`,
    )
  }

  const deployJobs = services.map((planned) => {
    return `deploy-${planned.name}`
  })

  const lines = [
    ...header(config, kind),
    ...dispatchInputs(config, kind, services),
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    ...terraformFiles.flatMap(terraformJob),
    ...services.flatMap((planned) => {
      return serviceJob(planned, kind, terraformJobs, config.extraEnv ?? [])
    }),
    ...(config.notifySuccess === undefined ? [] : notifyJob(config.notifySuccess, deployJobs)),
  ]

  // The first job follows `jobs:` directly; every later one is separated by a blank line.
  const content = `${lines.join('\n').replace('jobs:\n\n', 'jobs:\n')}\n`

  return { path: `.github/workflows/${KINDS[kind].file}`, content }
}

/**
 * The deploy-all and deploy-selected workflows a manifest describes. Pure: the same manifest always
 * renders byte-identical files, which is what lets `deploy-sync --check` compare them with disk.
 *
 * @example
 * renderDeployWorkflows({ environments: ['dev'], services: { 'client-be': {} } }).map((w) => w.path)
 * // => ['.github/workflows/deploy-all-v2.yml', '.github/workflows/deploy-selected-v2.yml']
 */
export const renderDeployWorkflows = (config: DeployConfig): GeneratedWorkflow[] => {
  return [renderWorkflow(config, 'all'), renderWorkflow(config, 'selected')]
}
