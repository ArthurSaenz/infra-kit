import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { discoverServices, eligibleServices, isEligible, resolveSsmPrefix } from '../service-discovery'
import type { DeployService } from '../service-discovery'

let repo: string

const write = async (file: string, body: string): Promise<void> => {
  await fs.writeFile(path.join(repo, 'devops/scripts', file), body, 'utf-8')
}

const byName = async (): Promise<Map<string, DeployService>> => {
  return new Map(
    (await discoverServices(repo)).map((service) => {
      return [service.name, service]
    }),
  )
}

// The tmp dir is `ik-deploy-XXXX`, so its basename is never `hulyo` — every `'hulyo'` below can only
// have come from the script text, which is the claim.
beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-deploy-'))

  await fs.mkdir(path.join(repo, 'devops/scripts/lib'), { recursive: true })

  // Unrestricted service, reading the environment parameter exactly as both consumers write it.
  await write(
    'deploy-client-be.sh',
    '#!/bin/bash\nDEPLOY_STAGE=$(aws ssm get-parameter --name "/hulyo/environment" --query \'Parameter.Value\' --output text)\n',
  )

  // Restricted, mirroring hulyo's deploy-mobile.sh:17; the `--name=` form with no quotes.
  await write(
    'deploy-mobile.sh',
    '#!/bin/bash\nDEPLOY_STAGE=$(aws ssm get-parameter --name=/hulyo/environment --query Parameter.Value --output text)\nskip_unless_env_enabled "$DEPLOY_STAGE" "Mobile MFE" "dev prod"\n',
  )

  // Restricted to a single env, mirroring travelist's prod-only media gate. Reads no SSM at all.
  await write('deploy-media.sh', '#!/bin/bash\nskip_unless_env_enabled "$DEPLOY_STAGE" "Media assets" "prod"\n')

  // The guard and the SSM read named only in a COMMENT must not be read as a restriction or a
  // prefix — deploy-utils.sh's own docblock mentions the function repeatedly.
  await write(
    'deploy-docs-fe.sh',
    '#!/bin/bash\n# skip_unless_env_enabled "$DEPLOY_STAGE" "Docs" "never-this"\n# DEPLOY_STAGE=$(aws ssm get-parameter --name "/never-this/environment" --query \'Parameter.Value\' --output text)\nDEPLOY_STAGE=x\n',
  )

  // Single quotes, and the substitution's `)` right after the closing quote.
  await write('deploy-paren.sh', "#!/bin/bash\nX=$(aws ssm get-parameter --name '/hulyo/environment')\n")

  // A different parameter under the same prefix — not an environment read.
  await write(
    'deploy-restid.sh',
    '#!/bin/bash\nrestApiIdWebsite=$(aws ssm get-parameter --name "/hulyo/api_gateway/website/restId" --query \'Parameter.Value\' --output text)\n',
  )

  // A literal sibling of the environment parameter — a different parameter, not an unparseable read.
  await write(
    'deploy-sibling.sh',
    '#!/bin/bash\nX=$(aws ssm get-parameter --name "/hulyo/environment_v2" --query \'Parameter.Value\' --output text)\n',
  )

  // Neither of these is a deployable service.
  await write('e2e-client.sh', '#!/bin/bash\n')
  await fs.writeFile(path.join(repo, 'devops/scripts/lib/deploy-utils.sh'), 'skip_unless_env_enabled() { :; }\n')
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('discoverServices', () => {
  it('finds deploy-*.sh only, excluding e2e scripts and the lib dir', async () => {
    const names = (await discoverServices(repo)).map((service) => {
      return service.name
    })

    expect(names).toStrictEqual(['client-be', 'docs-fe', 'media', 'mobile', 'paren', 'restid', 'sibling'])
  })

  it("reads the env allow-list from the script's own guard call", async () => {
    const services = await byName()

    expect(services.get('mobile')?.allowedEnvs).toStrictEqual(['dev', 'prod'])
    expect(services.get('media')?.allowedEnvs).toStrictEqual(['prod'])
  })

  it('treats a guard mentioned only in a comment as no restriction', async () => {
    const services = await byName()

    // null, not ['never-this'] — and null, not [], because [] would mean "deploys nowhere".
    expect(services.get('docs-fe')?.allowedEnvs).toBeNull()
  })

  it('returns [] for a repo with no deploy scripts rather than throwing', async () => {
    expect(await discoverServices(path.join(repo, 'does-not-exist'))).toStrictEqual([])
  })
})

describe('ssmPrefix', () => {
  it('reads the literal prefix in every form the consumers write', async () => {
    const services = await byName()

    expect(services.get('client-be')?.ssmPrefix).toBe('hulyo')
    expect(services.get('mobile')?.ssmPrefix).toBe('hulyo')
    expect(services.get('paren')?.ssmPrefix).toBe('hulyo')
  })

  // null (not 'never-this' for docs-fe) — each of these scripts reads no environment parameter,
  // whether because it reads no SSM at all, only mentions the read in a comment, or reads a
  // different parameter under the same prefix.
  it.each(['media', 'docs-fe', 'restid', 'sibling'])(
    'is null for %s, which reads no environment parameter',
    async (name) => {
      const services = await byName()

      expect(services.get(name)?.ssmPrefix).toBeNull()
    },
  )

  it('resolves the one prefix the fixture agrees on', async () => {
    expect(resolveSsmPrefix(await discoverServices(repo))).toBe('hulyo')
  })
})

describe('eligibility', () => {
  it('excludes restricted services from --all for an env they forbid', async () => {
    const services = await discoverServices(repo)

    const forStage = eligibleServices(services, 'stage').map((service) => {
      return service.name
    })

    // The bug this prevents: `--all --env stage` deploying mobile/media, which CI refuses.
    expect(forStage).toStrictEqual(['client-be', 'docs-fe', 'paren', 'restid', 'sibling'])
  })

  it('includes a restricted service for an env it allows', async () => {
    const services = await discoverServices(repo)

    const forProd = eligibleServices(services, 'prod').map((service) => {
      return service.name
    })

    expect(forProd).toStrictEqual(['client-be', 'docs-fe', 'media', 'mobile', 'paren', 'restid', 'sibling'])
  })

  it('treats a null allow-list as deploy-anywhere', () => {
    expect(isEligible({ name: 'x', scriptPath: '/x', allowedEnvs: null, ssmPrefix: null }, 'anything')).toBe(true)
    expect(isEligible({ name: 'x', scriptPath: '/x', allowedEnvs: ['dev'], ssmPrefix: null }, 'anything')).toBe(false)
  })
})
