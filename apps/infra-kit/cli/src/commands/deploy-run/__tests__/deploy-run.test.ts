import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentMode } from 'src/lib/agent-mode'
import type { ToolkitDeps } from 'src/lib/deploy-toolkit'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'

import { deployRun } from '../deploy-run'

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const commands: string[] = []
const logged: string[] = []

const deps: ToolkitDeps = {
  run: async (command, args, options) => {
    commands.push([command, ...args].join(' '))
    if (command === 'sh') commands.push(`MONITORING_IP=${options.env.MONITORING_IP}`)

    if (command === 'turbo' && args[0] === 'prune') {
      await fs.mkdir(path.join(options.cwd, 'out', 'apps', 'client-api'), { recursive: true })
    }
  },
  capture: async () => {
    return 'arthur\n'
  },
  sleep: async () => {},
  random: () => {
    return 0
  },
  log: (line) => {
    logged.push(line)
  },
}

// Each test gets its own repo: Node caches an imported module (manifest and script) by path.
let repo: string

beforeEach(async () => {
  commands.length = 0
  logged.length = 0
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-run-'))
  await fs.mkdir(path.join(repo, 'apps', 'client-api'), { recursive: true })
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ devDependencies: { turbo: '2.11.7' } }))
  await fs.writeFile(path.join(repo, 'apps', 'client-api', 'package.json'), JSON.stringify({ name: 'backend-api' }))
})

afterEach(async () => {
  agentMode.source = null
  await fs.rm(repo, { recursive: true, force: true })
})

/** `client-be` deploys with `apps/client-api/deploy.ts`, which holds `body`. */
const setUp = async (body: string, deploy = 'apps/client-api/deploy.ts') => {
  await fs.writeFile(
    path.join(repo, 'infra-kit.deploy.ts'),
    `export default { environments: ['dev'], services: { 'client-be': { deploy: '${deploy}' } } }\n`,
  )
  await fs.writeFile(path.join(repo, 'apps', 'client-api', 'deploy.ts'), body)
}

const run = (env: Record<string, string | undefined> = {}) => {
  return deployRun({ service: 'client-be', cwd: repo, env, deps })
}

describe('deployRun', () => {
  it('runs the manifest deploy against the app it sits in; its type-only import is erased at load', async () => {
    await setUp(`import type { DeployScript } from '@slip-stream-kit/config'

export default (async ({ ssm, deployBackendApi }) => {
  const { '/hulyo/environment': stage } = await ssm(['/hulyo/environment'])

  await deployBackendApi({ stage: stage! })
}) satisfies DeployScript
`)

    const result = await run()

    expect(result.structuredContent).toEqual({ status: 'deployed', service: 'client-be' })
    expect(commands).toContain('turbo prune backend-api')
    expect(commands).toContain('serverless deploy --stage arthur --force')
  })

  it('reports a skip as a skipped deploy, not a failure', async () => {
    await setUp(`export default async ({ skip }) => skip('client-be is off on dev')\n`)

    expect((await run()).structuredContent).toEqual({
      status: 'skipped',
      service: 'client-be',
      reason: 'client-be is off on dev',
    })
  })

  it('lets a failure through, so the deploy job fails', async () => {
    await setUp(`export default async () => { throw new Error('serverless deploy failed') }\n`)

    await expect(run()).rejects.toThrow('serverless deploy failed')
  })

  it('runs the .sh of a service without a deploy, the way the v1 jobs do', async () => {
    await setUp('export default async () => {}\n')
    await fs.mkdir(path.join(repo, 'devops', 'scripts'), { recursive: true })
    await fs.writeFile(path.join(repo, 'devops', 'scripts', 'deploy-seo-fe.sh'), 'exit 0\n')

    const result = await deployRun({ service: 'seo-fe', cwd: repo, env: {}, deps })

    expect(result.structuredContent).toEqual({ status: 'deployed', service: 'seo-fe' })
    expect(commands[0]).toBe(`sh ${path.join(repo, 'devops', 'scripts', 'deploy-seo-fe.sh')}`)
  })

  it('names a service with neither a deploy nor a .sh, and a missing deploy file', async () => {
    await expect(deployRun({ service: 'seo-fe', cwd: repo, env: {}, deps })).rejects.toThrow(
      'seo-fe has no deploy in infra-kit.deploy.ts and no devops/scripts/deploy-seo-fe.sh',
    )

    await setUp('export const deploy = 1\n', 'apps/client-api/missing.ts')

    await expect(run()).rejects.toThrow('missing.ts does not exist')
  })

  it('exports the extra-env lines to the script, each value masked in the job log first', async () => {
    await fs.mkdir(path.join(repo, 'devops', 'scripts'), { recursive: true })
    await fs.writeFile(path.join(repo, 'devops', 'scripts', 'deploy-seo-fe.sh'), 'exit 0\n')

    await deployRun({
      service: 'seo-fe',
      cwd: repo,
      env: { INFRA_KIT_EXTRA_ENV: 'MONITORING_IP=10.0.0.1\n\nTOKEN=a%25b\nEMPTY=' },
      deps,
    })

    expect(logged).toEqual(['::add-mask::10.0.0.1', '::add-mask::a%2525b'])
    expect(commands).toContain('MONITORING_IP=10.0.0.1')
  })

  it('refuses an extra-env line that is not KEY=VALUE', async () => {
    await expect(
      deployRun({ service: 'seo-fe', cwd: repo, env: { INFRA_KIT_EXTRA_ENV: 'lower=1' }, deps }),
    ).rejects.toThrow('an extra-env line is not KEY=VALUE')
  })

  it('refuses a script without a default function', async () => {
    await setUp('export const deploy = 1\n')

    await expect(run()).rejects.toThrow('no default-exported function')
  })

  it('refuses a service name that is not a manifest key', async () => {
    await expect(deployRun({ service: '../x', cwd: repo, env: {}, deps })).rejects.toThrow(
      "invalid service name '../x'",
    )
  })

  it('refuses an agent, unless local deploy-* ran its gates and spawned the script', async () => {
    agentMode.source = 'flag'
    await setUp(`export default async ({ run }) => { await run('true', []) }\n`)

    await expect(run()).rejects.toBeInstanceOf(StructuredRefusalError)
    expect(commands).toEqual([])
    expect((await run({ INFRA_KIT_DEPLOY_VIA: 'local-deploy' })).structuredContent.status).toBe('deployed')
  })
})
