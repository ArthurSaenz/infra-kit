/* eslint-disable no-template-curly-in-string -- the expected YAML holds literal GitHub `${{ }}` expressions */
import type { DeployConfig } from '@slip-stream-kit/config/internal'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import yaml from 'yaml'

import { readWorkflowGates } from 'src/lib/workflow-gates'

import packageJson from '../../../../package.json' with { type: 'json' }
import { SHARED_DEPLOY_JOB, SHARED_INSTALL_JOB, renderDeployWorkflows } from '../render-deploy-workflows'

interface Job {
  needs?: string[]
  if?: string
  uses: string
  with?: Record<string, unknown>
  secrets?: Record<string, string> | 'inherit'
}

interface Workflow {
  name: string
  'run-name': string
  concurrency: { group: string }
  on: { workflow_dispatch: { inputs: Record<string, { type: string; default?: unknown; options?: string[] }> } }
  jobs: Record<string, Job>
}

/** Shaped like travelist: a macOS service, an env-gated one, a local-workflow one kept out of deploy-all. */
const MANIFEST: DeployConfig = {
  environments: ['dev', 'arthur', 'stage'],
  defaultEnvironment: 'arthur',
  services: {
    'client-be': {},
    'client-fe': { runner: 'macos-14' },
    'docs-fe': { skipEnvs: ['stage', 'prod'] },
    mobile: { envs: ['dev', 'prod'], runner: 'macos-14' },
    'prod-only': { envs: ['prod'] },
    media: { workflow: '_deploy-media-jobs.yml', deployAll: false },
  },
  terraform: ['_terraform-apply-initUser-jobs.yml', '_terraform-apply-infrastructure-jobs.yml'],
  notifySuccess: '_notify-success-jobs.yml',
  extraEnv: ['MONITORING_IP', 'TOKEN_FLUX_DB'],
}

const render = (config: DeployConfig = MANIFEST) => {
  const [all, selected] = renderDeployWorkflows(config).map((workflow) => {
    return { ...workflow, parsed: yaml.parse(workflow.content) as Workflow }
  })

  return { all: all!, selected: selected! }
}

describe('renderDeployWorkflows', () => {
  it('writes the deploy-all and deploy-selected v2 files', () => {
    const { all, selected } = render()

    expect(all.path).toBe('.github/workflows/deploy-all-v2.yml')
    expect(selected.path).toBe('.github/workflows/deploy-selected-v2.yml')
    expect(all.parsed.concurrency.group).toBe('deploy-all-${{ inputs.environment }}')
    expect(selected.parsed.concurrency.group).toBe('deploy-selected-${{ inputs.environment }}')
  })

  it('offers one checkbox per selectable service, plus the environment and the terraform skip', () => {
    const { all, selected } = render()
    const inputs = selected.parsed.on.workflow_dispatch.inputs

    expect(Object.keys(inputs)).toEqual([
      'environment',
      'skip_terraform_deploy',
      'client-be',
      'client-fe',
      'docs-fe',
      'mobile',
      'media',
    ])
    expect(inputs.environment).toMatchObject({ default: 'arthur', options: ['dev', 'arthur', 'stage'] })
    expect(Object.keys(all.parsed.on.workflow_dispatch.inputs)).toEqual(['environment', 'skip_terraform_deploy'])
  })

  it('drops a service none of the offered environments may receive, and deployAll: false from deploy-all', () => {
    const { all, selected } = render()

    expect(Object.keys(selected.parsed.jobs)).not.toContain('deploy-prod-only')
    expect(Object.keys(all.parsed.jobs)).not.toContain('deploy-media')
    expect(Object.keys(selected.parsed.jobs)).toContain('deploy-media')
  })

  it('gates a service to the offered subset of its environments', () => {
    const { selected } = render()

    expect(selected.parsed.jobs['deploy-docs-fe']!.if).toContain(
      `contains(fromJSON('["dev","arthur"]'), inputs.environment)`,
    )
    expect(selected.parsed.jobs['deploy-mobile']!.if).toContain(`contains(fromJSON('["dev"]'), inputs.environment)`)
    expect(selected.parsed.jobs['deploy-client-be']!.if).not.toContain('fromJSON')
    expect(selected.parsed.on.workflow_dispatch.inputs.mobile).toMatchObject({ type: 'boolean' })
  })

  it('runs a service only when ticked and terraform succeeded or was skipped', () => {
    const { all, selected } = render()
    const job = selected.parsed.jobs['deploy-client-be']!

    expect(job.needs).toEqual(['install-deps', 'terraform-apply-initUser', 'terraform-apply-infrastructure'])
    expect(job.if).toMatch(/^\$\{\{ inputs\.client-be && !cancelled\(\) && /)
    expect(job.if).toContain(`needs.install-deps.result == 'success'`)
    expect(job.if).toContain(`needs.terraform-apply-infrastructure.result == 'skipped'`)
    expect(all.parsed.jobs['deploy-client-be']!.if).not.toContain('inputs.client-be')
  })

  it('sends script services to the pinned shared job with their runner and the explicit secrets', () => {
    const { selected } = render()
    const job = selected.parsed.jobs['deploy-client-fe']!

    expect(job.uses).toBe(SHARED_DEPLOY_JOB)
    expect(job.with).toEqual({
      environment: '${{ inputs.environment }}',
      ref: '${{ github.ref }}',
      sha: '${{ github.sha }}',
      service: 'client-fe',
      'infra-kit-version': packageJson.version,
      runner: 'macos-14',
    })
    expect(job.secrets).toMatchObject({
      'aws-region': "${{ secrets[format('{0}_AWS_REGION', inputs.environment)] }}",
      'extra-env': 'MONITORING_IP=${{ secrets.MONITORING_IP }}\nTOKEN_FLUX_DB=${{ secrets.TOKEN_FLUX_DB }}\n',
    })
    expect(selected.parsed.jobs['deploy-client-be']!.with).not.toHaveProperty('runner')
  })

  it('sends a workflow service to its own reusable workflow', () => {
    const { selected } = render()

    expect(selected.parsed.jobs['deploy-media']).toMatchObject({
      uses: './.github/workflows/_deploy-media-jobs.yml',
      with: { branch: '${{ github.ref }}', environment: '${{ inputs.environment }}' },
      secrets: 'inherit',
    })
  })

  it('notifies success only after a deploy succeeded and none failed', () => {
    const { all } = render()
    const notify = all.parsed.jobs['notify-success']!

    expect(notify.needs).toEqual(['deploy-client-be', 'deploy-client-fe', 'deploy-docs-fe', 'deploy-mobile'])
    expect(notify.if).toBe(
      "${{ !cancelled() && contains(needs.*.result, 'success') && !contains(needs.*.result, 'failure') }}",
    )
  })

  it('emits no terraform jobs or skip input without terraform, and still installs first', () => {
    const { selected } = render({ environments: ['dev'], services: { 'client-be': {} } })

    expect(Object.keys(selected.parsed.on.workflow_dispatch.inputs)).toEqual(['environment', 'client-be'])
    expect(selected.parsed.jobs['deploy-client-be']!.needs).toEqual(['install-deps'])
    expect(selected.parsed.jobs['deploy-client-be']!.if).toBe(
      "${{ inputs.client-be && !cancelled() && needs.install-deps.result == 'success' }}",
    )
    expect(selected.content).not.toContain('skip TF')
  })

  it('runs a pre-deploy job after terraform, even when terraform is skipped, and holds every service on it', () => {
    const { all, selected } = render({ ...MANIFEST, preDeploy: ['_publish-layer-jobs.yml'] })
    const publish = selected.parsed.jobs['publish-layer']!
    const service = selected.parsed.jobs['deploy-client-be']!

    expect(publish.needs).toEqual(['terraform-apply-initUser', 'terraform-apply-infrastructure'])
    expect(publish.if).toContain(`needs.terraform-apply-initUser.result == 'skipped'`)
    expect(publish.if).not.toContain('skip_terraform_deploy')
    expect(publish).toMatchObject({ uses: './.github/workflows/_publish-layer-jobs.yml', secrets: 'inherit' })
    expect(service.needs).toEqual([
      'install-deps',
      'terraform-apply-initUser',
      'terraform-apply-infrastructure',
      'publish-layer',
    ])
    expect(service.if).toContain(`needs.publish-layer.result == 'success'`)
    expect(all.parsed.jobs['deploy-client-be']!.needs).toContain('publish-layer')
    expect(all.parsed.jobs['notify-success']!.needs).not.toContain('publish-layer')
  })

  it('runs a pre-deploy job first when there is no terraform', () => {
    const { selected } = render({
      environments: ['dev'],
      services: { 'client-be': {} },
      preDeploy: ['_publish-layer-jobs.yml'],
    })

    expect(selected.parsed.jobs['publish-layer']).not.toHaveProperty('needs')
    expect(selected.parsed.jobs['publish-layer']).not.toHaveProperty('if')
    expect(selected.parsed.jobs['deploy-client-be']!.needs).toEqual(['install-deps', 'publish-layer'])
    expect(selected.parsed.jobs['deploy-client-be']!.if).toBe(
      "${{ inputs.client-be && !cancelled() && needs.install-deps.result == 'success' && needs.publish-layer.result == 'success' }}",
    )
  })

  it('installs once, beside terraform, through the pinned shared install job', () => {
    const { all, selected } = render()

    for (const workflow of [all, selected]) {
      expect(workflow.parsed.jobs['install-deps']).toEqual({
        uses: SHARED_INSTALL_JOB,
        with: { ref: '${{ github.ref }}', sha: '${{ github.sha }}' },
        secrets: { 'slack-token': '${{ secrets.SLACK_TOKEN }}', 'slack-channel': '${{ secrets.SLACK_CHANNEL }}' },
      })
    }

    expect(SHARED_INSTALL_JOB).toMatch(/@[0-9a-f]{40}$/)
    expect(all.parsed.jobs['notify-success']!.needs).not.toContain('install-deps')
  })

  it('passes the deploy step timeout only when the manifest sets one', () => {
    const { selected } = render({ ...MANIFEST, deployTimeoutMinutes: 60 })

    expect(selected.parsed.jobs['deploy-client-be']!.with).toMatchObject({ 'timeout-minutes': 60 })
    expect(render().selected.parsed.jobs['deploy-client-be']!.with).not.toHaveProperty('timeout-minutes')
  })

  it('titles a deploy-selected run with the ticked services, as v1 does', () => {
    const { all, selected } = render()

    expect(selected.parsed['run-name']).toContain("${{ inputs.client-be && 'client-be ' || '' }}")
    expect(selected.parsed['run-name']).toContain("${{ inputs.media && 'media ' || '' }}")
    expect(all.parsed['run-name']).not.toContain('inputs.client-be')
  })

  it('takes over the v1 file names, titles and concurrency groups under replaceV1', () => {
    const { all, selected } = render({ ...MANIFEST, replaceV1: true })

    expect(all.path).toBe('.github/workflows/deploy-all.yml')
    expect(selected.path).toBe('.github/workflows/deploy-selected-services.yml')
    expect(all.parsed.name).toBe('01 ⚙️ Deploy all')
    expect(selected.parsed.name).toBe('02 ⚙️ Deploy selected services')
    expect(all.parsed['run-name']).toMatch(/^01 ⚙️ Deploy all \[\$\{\{ inputs\.environment \}\}\]/)
    expect(all.parsed.concurrency.group).toBe('deploy-all-${{ inputs.environment }}')
  })

  it('refuses two jobs with one id', () => {
    expect(() => {
      return renderDeployWorkflows({ ...MANIFEST, preDeploy: ['_deploy-media-jobs.yml'] })
    }).toThrow(/job `deploy-media` twice/)
  })

  it('renders the same bytes for the same manifest', () => {
    expect(renderDeployWorkflows(MANIFEST)).toEqual(renderDeployWorkflows(structuredClone(MANIFEST)))
  })

  it('refuses a deploy-selected that would exceed the dispatch input limit', () => {
    const services = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => {
        return [`svc-${index}`, {}]
      }),
    )

    expect(() => {
      return renderDeployWorkflows({ environments: ['dev'], services, terraform: ['_tf.yml'] })
    }).toThrow(/26 dispatch inputs/)
  })

  // The CLI unions env gates across EVERY workflow in the repo; the pilot files must add none, or
  // `release deploy-*` would start refusing what v1 still deploys.
  it('adds nothing to what the workflow-gates reader sees', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-sync-gates-'))
    const dir = path.join(repo, '.github/workflows')

    await fs.mkdir(dir, { recursive: true })

    const v1 = `jobs:
  deploy-mobile:
    if: \${{ github.event.inputs.environment == 'dev' }}
    uses: ./.github/workflows/_deploy-serverless-jobs.yml
    with:
      script_name: mobile
`

    await fs.writeFile(path.join(dir, 'deploy-selected-services.yml'), v1)

    const before = await readWorkflowGates(repo)

    for (const workflow of renderDeployWorkflows(MANIFEST)) {
      await fs.writeFile(path.join(repo, workflow.path), workflow.content)
      expect(workflow.content).not.toMatch(/inputs\.environment\s*==/)
    }

    expect(await readWorkflowGates(repo)).toEqual(before)

    await fs.rm(repo, { recursive: true, force: true })
  })

  // Once the generated files ARE what `release deploy-*` dispatches, their gates are the manifest's.
  it('feeds the manifest gates to the workflow-gates reader under replaceV1', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-sync-gates-v1-'))
    const config: DeployConfig = { ...MANIFEST, environments: [...MANIFEST.environments, 'prod'], replaceV1: true }

    await fs.mkdir(path.join(repo, '.github/workflows'), { recursive: true })
    await fs.writeFile(path.join(repo, 'infra-kit.deploy.ts'), `export default ${JSON.stringify(config)}\n`)

    for (const workflow of renderDeployWorkflows(config)) {
      await fs.writeFile(path.join(repo, workflow.path), workflow.content)
    }

    expect(Object.fromEntries(await readWorkflowGates(repo))).toEqual({
      'docs-fe': ['dev', 'arthur'],
      mobile: ['dev', 'prod'],
      'prod-only': ['prod'],
    })

    await fs.rm(repo, { recursive: true, force: true })
  })
})
