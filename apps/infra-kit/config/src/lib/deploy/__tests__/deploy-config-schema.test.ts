import { describe, expect, it } from 'vitest'

import { deployConfigSchema } from '../deploy-config-schema'

const minimal = { environments: ['dev', 'stage'], services: { 'client-be': {} } }

describe('deployConfigSchema', () => {
  it('accepts a minimal manifest', () => {
    expect(deployConfigSchema.safeParse(minimal).success).toBe(true)
  })

  it('accepts every per-service option', () => {
    const result = deployConfigSchema.safeParse({
      ...minimal,
      defaultEnvironment: 'stage',
      services: {
        'client-fe': { runner: 'macos-14', envs: ['dev'] },
        'docs-fe': { skipEnvs: ['stage', 'prod'] },
        media: { workflow: '_deploy-media-jobs.yml', deployAll: ['prod'] },
        'storybook-fe': { deployAll: false },
      },
      terraform: ['_terraform-apply-infrastructure-jobs.yml'],
      preDeploy: ['_publish-layer-jobs.yml'],
      notifySuccess: '_notify-success-jobs.yml',
      extraEnv: ['MONITORING_IP'],
    })

    expect(result.success).toBe(true)
  })

  it('rejects an unknown key, so a typo is never silently ignored', () => {
    expect(deployConfigSchema.safeParse({ ...minimal, enviroments: ['dev'] }).success).toBe(false)
    expect(deployConfigSchema.safeParse({ ...minimal, services: { 'client-be': { env: ['dev'] } } }).success).toBe(
      false,
    )
  })

  it('rejects envs and skipEnvs on one service', () => {
    const services = { 'docs-fe': { envs: ['dev'], skipEnvs: ['stage'] } }

    expect(deployConfigSchema.safeParse({ ...minimal, services }).success).toBe(false)
  })

  it('accepts replaceV1 and a deploy timeout within the GitHub job cap', () => {
    expect(deployConfigSchema.safeParse({ ...minimal, replaceV1: true, deployTimeoutMinutes: 60 }).success).toBe(true)
    expect(deployConfigSchema.safeParse({ ...minimal, deployTimeoutMinutes: 0 }).success).toBe(false)
    expect(deployConfigSchema.safeParse({ ...minimal, deployTimeoutMinutes: 361 }).success).toBe(false)
  })

  it('takes an SSM project prefix of lower-case letters, digits and dashes', () => {
    const project = (value: string) => {
      return deployConfigSchema.safeParse({ ...minimal, project: value }).success
    }

    expect(project('hulyo')).toBe(true)
    expect(project('travelist-2')).toBe(true)
    expect(project('Hulyo')).toBe(false)
    expect(project('/hulyo')).toBe(false)
    expect(project('hu_lyo')).toBe(false)
    expect(project('')).toBe(false)
  })

  it('rejects a service named after a dispatch input every workflow has', () => {
    expect(deployConfigSchema.safeParse({ ...minimal, services: { environment: {} } }).success).toBe(false)
  })

  it('takes a repo-relative .ts deploy path, never beside a workflow, never escaping the repo', () => {
    const service = (deploy: string, extra = {}) => {
      return deployConfigSchema.safeParse({ ...minimal, services: { 'client-be': { deploy, ...extra } } }).success
    }

    expect(service('apps/client/api/deploy.ts')).toBe(true)
    expect(service('apps/client/api/deploy.ts', { workflow: '_x.yml' })).toBe(false)
    expect(service('../other/deploy.ts')).toBe(false)
    expect(service('apps/client/api/deploy.sh')).toBe(false)
  })

  it('rejects a manifest without services', () => {
    expect(deployConfigSchema.safeParse({ ...minimal, services: {} }).success).toBe(false)
  })

  it('rejects a default environment that is not offered', () => {
    expect(deployConfigSchema.safeParse({ ...minimal, defaultEnvironment: 'prod' }).success).toBe(false)
  })

  it('rejects names that cannot become job ids, input keys or secret names', () => {
    expect(deployConfigSchema.safeParse({ ...minimal, services: { Client_BE: {} } }).success).toBe(false)
    expect(deployConfigSchema.safeParse({ ...minimal, environments: ['Dev'] }).success).toBe(false)
    expect(deployConfigSchema.safeParse({ ...minimal, extraEnv: ['monitoring-ip'] }).success).toBe(false)
  })

  it('rejects a pre-deploy workflow that is already a terraform one', () => {
    const terraform = ['_tf.yml']

    expect(deployConfigSchema.safeParse({ ...minimal, terraform, preDeploy: terraform }).success).toBe(false)
  })

  it('rejects a workflow reference that is a path rather than a file name', () => {
    expect(deployConfigSchema.safeParse({ ...minimal, terraform: ['../x.yml'] }).success).toBe(false)
    expect(deployConfigSchema.safeParse({ ...minimal, notifySuccess: 'other/_n.yml' }).success).toBe(false)
  })

  it('accepts service order and a Doppler project', () => {
    const result = deployConfigSchema.safeParse({
      ...minimal,
      services: {
        'db-migrate': { runsBefore: ['client-be', 'backoffice-be'] },
        'client-be': {},
        'backoffice-be': {},
        'ai-be': { after: ['client-be'] },
      },
      doppler: { project: 'nomadream' },
    })

    expect(result.success).toBe(true)
  })

  it('rejects an order that names an unknown service or the service itself', () => {
    const unknown = { 'client-be': { after: ['ai-be'] } }
    const itself = { 'client-be': { runsBefore: ['client-be'] } }

    expect(deployConfigSchema.safeParse({ ...minimal, services: unknown }).success).toBe(false)
    expect(deployConfigSchema.safeParse({ ...minimal, services: itself }).success).toBe(false)
  })

  it('rejects an order cycle, including one closed by a runsBefore step', () => {
    const direct = { a: { after: ['b'] }, b: { after: ['a'] } }
    const viaStep = { migrate: { runsBefore: ['api'], after: ['api'] }, api: {} }

    expect(deployConfigSchema.safeParse({ ...minimal, services: direct }).success).toBe(false)
    expect(deployConfigSchema.safeParse({ ...minimal, services: viaStep }).success).toBe(false)
  })

  it('rejects deployAll on a runsBefore step', () => {
    const services = { migrate: { runsBefore: ['client-be'], deployAll: false }, 'client-be': {} }

    expect(deployConfigSchema.safeParse({ ...minimal, services }).success).toBe(false)
  })
})
