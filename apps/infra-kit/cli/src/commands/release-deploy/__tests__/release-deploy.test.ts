import { beforeEach, describe, expect, it, vi } from 'vitest'

const ghReleaseDeployAll = vi.fn()
const ghReleaseDeploySelected = vi.fn()
const localDeployAll = vi.fn()
const localDeploySelected = vi.fn()
const warn = vi.fn()
const addOption = vi.fn()

vi.mock('src/commands/gh-release-deploy-all', () => {
  return { ghReleaseDeployAll }
})
vi.mock('src/commands/gh-release-deploy-selected', () => {
  return { ghReleaseDeploySelected }
})
vi.mock('src/commands/local-deploy', () => {
  return { localDeployAll, localDeploySelected }
})
vi.mock('src/lib/logger', () => {
  return { logger: { warn, info: vi.fn(), error: vi.fn() } }
})
vi.mock('src/lib/command-echo', () => {
  return { commandEcho: { addOption, setInteractive: vi.fn(), print: vi.fn() } }
})

const { deprecatedLocalDeploy, releaseDeployAll, releaseDeploySelected } = await import('../release-deploy')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('--from routing', () => {
  it('sends --from ci to the workflow dispatcher, preserving every CI argument', async () => {
    await releaseDeployAll({ from: 'ci', version: '1.2.5', env: 'dev', skipTerraform: true, yes: true })

    expect(ghReleaseDeployAll).toHaveBeenCalledWith({
      version: '1.2.5',
      env: 'dev',
      skipTerraform: true,
      confirmedCommand: true,
    })
    expect(localDeployAll).not.toHaveBeenCalled()
  })

  it('leaves --version optional so the release picker still runs', async () => {
    await releaseDeployAll({ from: 'ci', env: 'dev' })

    expect(ghReleaseDeployAll).toHaveBeenCalledWith({
      version: undefined,
      env: 'dev',
      skipTerraform: undefined,
      confirmedCommand: undefined,
    })
  })

  // TEMPORARILY DISABLED with the local runner (see `release-deploy.ts`); restore together.
  //   it('sends --from local to the local runner', async () => {
  //     await releaseDeployAll({ from: 'local', env: 'dev', dryRun: true })
  //
  //     expect(localDeployAll).toHaveBeenCalledWith({
  //       env: 'dev',
  //       confirmedCommand: undefined,
  //       dryRun: true,
  //       printEnv: undefined,
  //     })
  //     expect(ghReleaseDeployAll).not.toHaveBeenCalled()
  //   })
  //
  //   // The CLI's `--yes` must reach the local runner as `confirmedCommand`, the field the MCP chokepoint
  //   // injects (`tool-handler.ts:466`) and the one `runLocalDeploy` now gates on. Spelled `yes`, the
  //   // local entrypoints read a field nothing injects, so every MCP call fell through to `confirmTarget`
  //   // and wrote an inquirer prompt into the JSON-RPC stream. Asserting `true` rather than presence: a
  //   // normalization that forwarded `undefined` would satisfy a mere `objectContaining` on the key.
  //   it('normalizes --yes onto confirmedCommand for the local runner, as it does for the CI one', async () => {
  //     await releaseDeployAll({ from: 'local', env: 'dev', yes: true })
  //
  //     expect(localDeployAll).toHaveBeenCalledWith(expect.objectContaining({ confirmedCommand: true }))
  //   })
  //
  //   it('maps the single --services flag onto the local runner’s `service` parameter', async () => {
  //     // The merged surface exposes ONE service flag; the local entrypoint keeps `service`, which is what
  //     // its MCP tool declares and must keep declaring.
  //     await releaseDeploySelected({ from: 'local', env: 'dev', services: ['client-be'] })
  //
  //     expect(localDeploySelected).toHaveBeenCalledWith(expect.objectContaining({ service: ['client-be'] }))
  //   })

  it('passes --services through unrenamed on the CI path', async () => {
    await releaseDeploySelected({ from: 'ci', version: 'dev', env: 'dev', services: ['client-be'] })

    expect(ghReleaseDeploySelected).toHaveBeenCalledWith(expect.objectContaining({ services: ['client-be'] }))
  })
})

describe('flag/source guards', () => {
  it('refuses a missing --from before dispatching anything', async () => {
    await expect(releaseDeployAll({ env: 'dev' })).rejects.toThrow(/--from is required/)

    expect(ghReleaseDeployAll).not.toHaveBeenCalled()
    expect(localDeployAll).not.toHaveBeenCalled()
  })

  // TEMPORARILY DISABLED with the local runner: the disabled-source refusal fires before the flag guard.
  // it('refuses --skip-terraform on the local path instead of silently dropping it', async () => {
  //   await expect(releaseDeployAll({ from: 'local', skipTerraform: true })).rejects.toThrow(
  //     /--skip-terraform is not valid/,
  //   )
  //
  //   expect(localDeployAll).not.toHaveBeenCalled()
  // })

  it('refuses --dry-run on the ci path', async () => {
    await expect(releaseDeployAll({ from: 'ci', dryRun: true })).rejects.toThrow(/--dry-run is not valid/)

    expect(ghReleaseDeployAll).not.toHaveBeenCalled()
  })
})

// TEMPORARILY DISABLED with the local runner (see `release-deploy.ts`); restore together.
// describe('deprecated local aliases', () => {
//   it('still runs, pinned to local, and names its replacement', async () => {
//     await deprecatedLocalDeploy({ env: 'dev' }, 'all')
//
//     expect(localDeployAll).toHaveBeenCalledWith(expect.objectContaining({ env: 'dev' }))
//     expect(warn).toHaveBeenCalledWith(expect.stringContaining('release deploy-all --from local'))
//   })
//
//   it('cannot be pointed at the CI path by its caller', async () => {
//     await deprecatedLocalDeploy({ env: 'dev', services: ['client-be'] }, 'selected')
//
//     expect(localDeploySelected).toHaveBeenCalledOnce()
//     expect(ghReleaseDeploySelected).not.toHaveBeenCalled()
//   })
//
//   it('carries the old --service payload all the way through the rename', async () => {
//     // `--service` (alias) -> `services` (merged args) -> `service` (local entrypoint). A count-only
//     // assertion would pass even if the names stopped lining up and the payload arrived empty.
//     await deprecatedLocalDeploy({ env: 'dev', services: ['client-be', 'client-fe'] }, 'selected')
//
//     expect(localDeploySelected).toHaveBeenCalledWith(expect.objectContaining({ service: ['client-be', 'client-fe'] }))
//   })
// })

describe('local runner disabled (temporary)', () => {
  // Every entry path that can pin `local` must land on the same refusal, before any runner is called.
  it('refuses --from local on deploy-all', async () => {
    await expect(releaseDeployAll({ from: 'local', env: 'dev' })).rejects.toThrow(/local deploys are disabled/)

    expect(localDeployAll).not.toHaveBeenCalled()
    expect(ghReleaseDeployAll).not.toHaveBeenCalled()
  })

  it('refuses --from local on deploy-selected', async () => {
    await expect(releaseDeploySelected({ from: 'local', env: 'dev', services: ['client-be'] })).rejects.toThrow(
      /local deploys are disabled/,
    )

    expect(localDeploySelected).not.toHaveBeenCalled()
  })

  it('refuses the deprecated aliases, which pin local internally', async () => {
    await expect(deprecatedLocalDeploy({ env: 'dev' }, 'all')).rejects.toThrow(/local deploys are disabled/)
    await expect(deprecatedLocalDeploy({ env: 'dev', services: ['client-be'] }, 'selected')).rejects.toThrow(
      /local deploys are disabled/,
    )

    expect(localDeployAll).not.toHaveBeenCalled()
    expect(localDeploySelected).not.toHaveBeenCalled()
  })

  it('still routes --from ci to CI', async () => {
    await releaseDeployAll({ from: 'ci', version: 'dev', env: 'dev' })

    expect(ghReleaseDeployAll).toHaveBeenCalledOnce()
  })
})

describe('echoed command stays runnable', () => {
  it('echoes --from on the merged command, which accepts it', async () => {
    await releaseDeployAll({ from: 'ci', version: 'dev', env: 'dev' })

    expect(addOption).toHaveBeenCalledWith('--from', 'ci')
  })

  it('does NOT echo --from on the deprecated alias, which cannot parse it', async () => {
    // The aliases register no `--from` (deploy-wiring.test.ts asserts that), so echoing it produced
    // `pnpm exec infra-kit local deploy-all --from "local" …` — a printed command commander rejects
    // with `unknown option '--from'`. A printed command that cannot be re-run is worse than none.
    // The alias is refused while the local runner is disabled, but the echo decision precedes the refusal.
    await expect(deprecatedLocalDeploy({ env: 'dev' }, 'all')).rejects.toThrow(/local deploys are disabled/)

    expect(addOption).not.toHaveBeenCalledWith('--from', expect.anything())
  })
})
