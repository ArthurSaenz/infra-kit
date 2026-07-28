import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { discoverServices, eligibleServices, isEligible } from '../service-discovery'

let repo: string

const write = async (file: string, body: string): Promise<void> => {
  await fs.writeFile(path.join(repo, 'devops/scripts', file), body, 'utf-8')
}

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-deploy-'))

  await fs.mkdir(path.join(repo, 'devops/scripts/lib'), { recursive: true })

  // Unrestricted service.
  await write('deploy-client-be.sh', '#!/bin/bash\nDEPLOY_STAGE=$(aws ssm get-parameter ...)\n')

  // Restricted, mirroring hulyo's deploy-mobile.sh:17.
  await write(
    'deploy-mobile.sh',
    '#!/bin/bash\nDEPLOY_STAGE=x\nskip_unless_env_enabled "$DEPLOY_STAGE" "Mobile MFE" "dev prod"\n',
  )

  // Restricted to a single env, mirroring travelist's prod-only media gate.
  await write('deploy-media.sh', '#!/bin/bash\nskip_unless_env_enabled "$DEPLOY_STAGE" "Media assets" "prod"\n')

  // The guard named only in a COMMENT must not be read as a restriction — deploy-utils.sh's own
  // docblock mentions the function repeatedly.
  await write(
    'deploy-docs-fe.sh',
    '#!/bin/bash\n# skip_unless_env_enabled "$DEPLOY_STAGE" "Docs" "never-this"\nDEPLOY_STAGE=x\n',
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

    expect(names).toStrictEqual(['client-be', 'docs-fe', 'media', 'mobile'])
  })

  it("reads the env allow-list from the script's own guard call", async () => {
    const services = await discoverServices(repo)
    const byName = new Map(
      services.map((service) => {
        return [service.name, service]
      }),
    )

    expect(byName.get('mobile')?.allowedEnvs).toStrictEqual(['dev', 'prod'])
    expect(byName.get('media')?.allowedEnvs).toStrictEqual(['prod'])
  })

  it('treats a guard mentioned only in a comment as no restriction', async () => {
    const services = await discoverServices(repo)
    const docs = services.find((service) => {
      return service.name === 'docs-fe'
    })

    // null, not ['never-this'] — and null, not [], because [] would mean "deploys nowhere".
    expect(docs?.allowedEnvs).toBeNull()
  })

  it('returns [] for a repo with no deploy scripts rather than throwing', async () => {
    expect(await discoverServices(path.join(repo, 'does-not-exist'))).toStrictEqual([])
  })
})

describe('eligibility', () => {
  it('excludes restricted services from --all for an env they forbid', async () => {
    const services = await discoverServices(repo)

    const forStage = eligibleServices(services, 'stage').map((service) => {
      return service.name
    })

    // The bug this prevents: `--all --env stage` deploying mobile/media, which CI refuses.
    expect(forStage).toStrictEqual(['client-be', 'docs-fe'])
  })

  it('includes a restricted service for an env it allows', async () => {
    const services = await discoverServices(repo)

    const forProd = eligibleServices(services, 'prod').map((service) => {
      return service.name
    })

    expect(forProd).toStrictEqual(['client-be', 'docs-fe', 'media', 'mobile'])
  })

  it('treats a null allow-list as deploy-anywhere', () => {
    expect(isEligible({ name: 'x', scriptPath: '/x', allowedEnvs: null }, 'anything')).toBe(true)
    expect(isEligible({ name: 'x', scriptPath: '/x', allowedEnvs: ['dev'] }, 'anything')).toBe(false)
  })
})
