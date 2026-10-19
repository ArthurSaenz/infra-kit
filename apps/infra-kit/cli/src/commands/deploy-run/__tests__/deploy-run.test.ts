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

const deps: ToolkitDeps = {
  run: async (command, args) => {
    commands.push([command, ...args].join(' '))
  },
  capture: async () => {
    return JSON.stringify({ Parameters: [{ Name: '/hulyo/environment', Value: 'arthur' }] })
  },
  sleep: async () => {},
  random: () => {
    return 0
  },
  log: () => {},
}

// Each test writes its script into its own repo: Node caches an imported module by path.
let repo: string

beforeEach(async () => {
  commands.length = 0
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-run-'))
  await fs.mkdir(path.join(repo, 'devops/scripts'), { recursive: true })
})

afterEach(async () => {
  agentMode.source = null
  await fs.rm(repo, { recursive: true, force: true })
})

const writeScript = async (service: string, body: string) => {
  await fs.writeFile(path.join(repo, 'devops/scripts', `deploy-${service}.ts`), body)
}

describe('deployRun', () => {
  it('runs the script with the toolkit; its type-only import is erased at load', async () => {
    await writeScript(
      'client-be',
      `import type { DeployScript } from '@slip-stream-kit/config'

export default (async ({ ssm, run, service }) => {
  const { '/hulyo/environment': stage } = await ssm(['/hulyo/environment'])

  await run('echo', [service, stage ?? ''])
}) satisfies DeployScript
`,
    )

    const result = await deployRun({ service: 'client-be', cwd: repo, env: {}, deps })

    expect(result.structuredContent).toEqual({ status: 'deployed', service: 'client-be' })
    expect(commands).toEqual(['echo client-be arthur'])
  })

  it('reports a skip as a skipped deploy, not a failure', async () => {
    await writeScript('mobile', `export default async ({ skip }) => skip('mobile deploys to dev and prod only')\n`)

    const result = await deployRun({ service: 'mobile', cwd: repo, env: {}, deps })

    expect(result.structuredContent).toEqual({
      status: 'skipped',
      service: 'mobile',
      reason: 'mobile deploys to dev and prod only',
    })
  })

  it('lets a failure through, so the deploy job fails', async () => {
    await writeScript('docs-fe', `export default async () => { throw new Error('serverless deploy failed') }\n`)

    await expect(deployRun({ service: 'docs-fe', cwd: repo, env: {}, deps })).rejects.toThrow(
      'serverless deploy failed',
    )
  })

  it('names the missing script and a script without a default function', async () => {
    await expect(deployRun({ service: 'seo-fe', cwd: repo, env: {}, deps })).rejects.toThrow(
      'deploy-seo-fe.ts does not exist',
    )

    await writeScript('julyo-be', 'export const deploy = 1\n')

    await expect(deployRun({ service: 'julyo-be', cwd: repo, env: {}, deps })).rejects.toThrow(
      'no default-exported function',
    )
  })

  it('refuses a service name that is not a script suffix', async () => {
    await expect(deployRun({ service: '../x', cwd: repo, env: {}, deps })).rejects.toThrow(
      "invalid service name '../x'",
    )
  })

  it('refuses an agent, unless local deploy-* ran its gates and spawned the script', async () => {
    agentMode.source = 'flag'
    await writeScript('backoffice-be', `export default async ({ run }) => { await run('true', []) }\n`)

    await expect(deployRun({ service: 'backoffice-be', cwd: repo, env: {}, deps })).rejects.toBeInstanceOf(
      StructuredRefusalError,
    )
    expect(commands).toEqual([])

    const viaLocal = await deployRun({
      service: 'backoffice-be',
      cwd: repo,
      env: { INFRA_KIT_DEPLOY_VIA: 'local-deploy' },
      deps,
    })

    expect(viaLocal.structuredContent.status).toBe('deployed')
  })
})
