import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { discoverServices, resolveSsmPrefix } from '../service-discovery'
import type { DeployService } from '../service-discovery'

const repos: string[] = []

const repoWith = async (config: unknown, files: Record<string, string>): Promise<string> => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-deploy-manifest-'))

  repos.push(repo)

  await fs.writeFile(path.join(repo, 'infra-kit.deploy.ts'), `export default ${JSON.stringify(config)}\n`)

  for (const [file, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true })
    await fs.writeFile(path.join(repo, file), body, 'utf-8')
  }

  return repo
}

const byName = async (repo: string): Promise<Map<string, DeployService>> => {
  return new Map(
    (await discoverServices(repo)).map((service) => {
      return [service.name, service]
    }),
  )
}

const ENVIRONMENTS = ['dev', 'arthur', 'stage']

const DEPLOY_TS = "const parameters = await ssm(['/hulyo/environment', '/hulyo/api_gateway/website/restId'])\n"

afterAll(async () => {
  await Promise.all(
    repos.map((repo) => {
      return fs.rm(repo, { recursive: true, force: true })
    }),
  )
})

describe('discoverServices with infra-kit.deploy.ts', () => {
  it('offers manifest services: a deploy.ts through deploy-run, a .sh fallback, nothing without either', async () => {
    const repo = await repoWith(
      {
        environments: ENVIRONMENTS,
        services: {
          'client-be': { deploy: 'apps/client/api/deploy.ts' },
          media: { workflow: '_deploy-media-jobs.yml' },
          ghost: {},
        },
      },
      {
        'apps/client/api/deploy.ts': DEPLOY_TS,
        'devops/scripts/deploy-media.sh': '#!/bin/bash\nskip_unless_env_enabled "$DEPLOY_STAGE" "Media" "dev stage"\n',
        // On disk but not in the manifest: the manifest, not the glob, is the service list.
        'devops/scripts/deploy-orphan.sh': '#!/bin/bash\n',
      },
    )

    const services = await byName(repo)

    expect([...services.keys()]).toStrictEqual(['client-be', 'media'])
    expect(services.get('client-be')).toMatchObject({
      runner: 'deploy-run',
      scriptPath: path.join(repo, 'apps/client/api/deploy.ts'),
      ssmPrefix: 'hulyo',
    })
    expect(services.get('media')).toMatchObject({ runner: 'sh', allowedEnvs: ['dev', 'stage'], ssmPrefix: null })
  })

  it('gates on the manifest envs/skipEnvs, intersected with the .sh guard and the workflow gates', async () => {
    const repo = await repoWith(
      {
        environments: ENVIRONMENTS,
        services: {
          'docs-fe': { skipEnvs: ['stage'], deploy: 'docs/deploy.ts' },
          mobile: { envs: ['dev', 'prod'], deploy: 'mobile/deploy.ts' },
          media: { envs: ['dev', 'arthur'] },
          'client-be': { deploy: 'client/deploy.ts' },
        },
      },
      {
        'docs/deploy.ts': DEPLOY_TS,
        'mobile/deploy.ts': DEPLOY_TS,
        'client/deploy.ts': DEPLOY_TS,
        'devops/scripts/deploy-media.sh': '#!/bin/bash\nskip_unless_env_enabled "$DEPLOY_STAGE" "Media" "dev stage"\n',
        // A v1 workflow CI still dispatches gates client-be to dev.
        '.github/workflows/deploy-all.yml':
          "jobs:\n  deploy-client-be:\n    if: inputs.environment == 'dev'\n    with:\n      script_name: client-be\n",
      },
    )

    const services = await byName(repo)

    expect(services.get('docs-fe')?.allowedEnvs).toStrictEqual(['dev', 'arthur'])
    expect(services.get('mobile')?.allowedEnvs).toStrictEqual(['dev', 'prod'])
    expect(services.get('media')?.allowedEnvs).toStrictEqual(['dev'])
    expect(services.get('client-be')?.allowedEnvs).toStrictEqual(['dev'])
  })
})

describe('resolveSsmPrefix with infra-kit.deploy.ts', () => {
  it('reads the prefix from the deploy.ts literals, ignoring comments and sibling parameters', async () => {
    const repo = await repoWith(
      {
        environments: ENVIRONMENTS,
        services: { a: { deploy: 'a/deploy.ts' }, b: { deploy: 'b/deploy.ts' }, c: { deploy: 'c/deploy.ts' } },
      },
      {
        'a/deploy.ts': DEPLOY_TS,
        'b/deploy.ts': '// ssm([\'/never-this/environment\'])\nconst x = await ssm(["/hulyo/environment_v2"])\n',
        'c/deploy.ts': 'const stage = (await ssm([`/hulyo/environment`]))[`/hulyo/environment`]\n',
      },
    )

    const services = await byName(repo)

    expect(services.get('b')?.ssmPrefix).toBeNull()
    expect(services.get('c')?.ssmPrefix).toBe('hulyo')
    expect(resolveSsmPrefix([...services.values()])).toBe('hulyo')
  })

  it('refuses disagreeing deploy.ts files, naming each by its service', async () => {
    const repo = await repoWith(
      { environments: ENVIRONMENTS, services: { a: { deploy: 'a/deploy.ts' }, b: { deploy: 'b/deploy.ts' } } },
      { 'a/deploy.ts': DEPLOY_TS, 'b/deploy.ts': "await ssm(['/travelist/environment'])\n" },
    )

    const services = await discoverServices(repo)

    expect(() => {
      return resolveSsmPrefix(services)
    }).toThrow(/hulyo: a \(deploy\.ts\)/)
    expect(() => {
      return resolveSsmPrefix(services)
    }).toThrow(/travelist: b \(deploy\.ts\)/)
  })

  it('refuses a template literal building the parameter, naming service:line', async () => {
    const repo = await repoWith(
      { environments: ENVIRONMENTS, services: { a: { deploy: 'a/deploy.ts' } } },
      // eslint-disable-next-line no-template-curly-in-string
      { 'a/deploy.ts': "const project = 'hulyo'\nawait ssm([`/${project}/environment`])\n" },
    )

    const services = await discoverServices(repo)

    expect(() => {
      return resolveSsmPrefix(services)
    }).toThrow(/a \(deploy\.ts\):2:/)
    expect(() => {
      return resolveSsmPrefix(services)
    }).toThrow(/literal/)
  })

  it('refuses a manifest whose scripts read no environment parameter', async () => {
    const repo = await repoWith(
      { environments: ENVIRONMENTS, services: { a: { deploy: 'a/deploy.ts' } } },
      { 'a/deploy.ts': 'export default async () => {}\n' },
    )

    const services = await discoverServices(repo)

    expect(() => {
      return resolveSsmPrefix(services)
    }).toThrow(/none of 1 deploy scripts reads/)
  })
})
