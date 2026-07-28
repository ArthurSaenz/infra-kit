import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

import { discoverServices, eligibleServices } from '../service-discovery'

/**
 * Runs against the real consumer monorepos when they are checked out beside infra-kit.
 *
 * Fixtures prove the parser; only this proves the parser matches what these two repos actually
 * contain — which is the claim that matters, since every rule here was read out of them.
 */
const REPOS = {
  hulyo: '/Users/arthur/projects/hulyo-monorepo',
  travelist: '/Users/arthur/projects/travelist-monorepo',
}

const present = (repo: string): boolean => {
  return fs.existsSync(`${repo}/devops/scripts`)
}

describe.runIf(present(REPOS.hulyo))('hulyo', () => {
  it('discovers real services, excluding the workflow phantoms', async () => {
    const names = (await discoverServices(REPOS.hulyo)).map((service) => {
      return service.name
    })

    // `deploy-selected-services.yml` offers live `ai-ui` and `widgets-fe` checkboxes whose scripts do
    // not exist — ticking either fails the job. Disk is the truth.
    expect(names).not.toContain('ai-ui')
    expect(names).not.toContain('widgets-fe')

    // `media` has no `script_name` anywhere (it has its own workflow) but is genuinely deployable.
    expect(names).toContain('media')
    expect(names).toContain('widget-cards-list-fe')
  })

  it('reads the real env restrictions', async () => {
    const services = await discoverServices(REPOS.hulyo)
    const byName = new Map(
      services.map((service) => {
        return [service.name, service]
      }),
    )

    expect(byName.get('mobile')?.allowedEnvs).toStrictEqual(['dev', 'prod'])
    expect(byName.get('docs-fe')?.allowedEnvs).toStrictEqual(
      expect.arrayContaining(['dev', 'arthur', 'eliran', 'renana', 'roman', 'oriana']),
    )
    expect(byName.get('client-be')?.allowedEnvs).toBeNull()
  })

  it('--all excludes services CI would not deploy to that env', async () => {
    const services = await discoverServices(REPOS.hulyo)

    const forStage = eligibleServices(services, 'stage').map((service) => {
      return service.name
    })

    // The bug this prevents: a local `--all --env stage` shipping docs-fe and mobile, which CI refuses.
    expect(forStage).not.toContain('docs-fe')
    expect(forStage).not.toContain('mobile')
    expect(forStage).toContain('client-be')
  })
})

describe.runIf(present(REPOS.travelist))('travelist', () => {
  it('honours workflow gates even where the script has no guard', async () => {
    const services = await discoverServices(REPOS.travelist)
    const byName = new Map(
      services.map((service) => {
        return [service.name, service]
      }),
    )

    // Neither script carries `skip_unless_env_enabled` — hulyo's equivalents do. Reading the scripts
    // alone would make these look unrestricted and let `--all` deploy them where CI will not.
    expect(byName.get('mobile')?.allowedEnvs).toStrictEqual(['dev', 'prod'])
    expect(byName.get('media')?.allowedEnvs).toStrictEqual(['prod'])
  })

  it('--all on a personal env excludes prod-only media', async () => {
    const services = await discoverServices(REPOS.travelist)

    const forArthur = eligibleServices(services, 'arthur').map((service) => {
      return service.name
    })

    expect(forArthur).not.toContain('media')
    expect(forArthur).not.toContain('mobile')
    expect(forArthur).toContain('client-be')
  })
})
