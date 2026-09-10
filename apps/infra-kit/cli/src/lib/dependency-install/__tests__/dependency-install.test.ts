import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

import { runRecipe } from 'src/lib/dependency-install/dependency-install'
import type { RiskContext } from 'src/lib/dependency-install/risk-predicate'
import { specFor } from 'src/lib/dependency-registry'

/**
 * The executor's job is to run nothing it should not, so most of these assert on the spawner NOT being
 * called. A test that only checked the happy path would pass against a build with both guards deleted.
 */

const ok = { status: 0, signal: null, error: undefined } as unknown as ReturnType<
  typeof import('node:child_process').spawnSync
>

const spawnOk = () => {
  return vi.fn().mockReturnValue(ok)
}

/** Everything present, nothing owned — so a refusal here is never the detection conjuncts talking. */
const BREW_PRESENT: RiskContext = { owner: null, present: ['homebrew', 'npm', 'script'] }

const notInMcp = () => {
  return false
}

describe('recipe safety and caller authority are separate refusals', () => {
  it('never spawns the Homebrew bootstrap, even from a CLI with a human present', () => {
    const spawn = spawnOk()
    const outcome = runRecipe(specFor('brew').bootstrapInstall, BREW_PRESENT, { spawnSync: spawn, mcpMode: notInMcp })

    expect(outcome.ran).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(outcome.ran === false && outcome.refusedBecause).toEqual(
      expect.arrayContaining(['needs-sudo', 'fetches-network-script']),
    )
  })

  it('never spawns a SAFE recipe when this process is serving MCP', () => {
    const spawn = spawnOk()
    const outcome = runRecipe(specFor('gh').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn,
      mcpMode: () => {
        return true
      },
    })

    expect(outcome.ran).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(outcome.ran === false && outcome.refusedBecause).toEqual(['mcp-mode'])
  })

  it('hands back the argv on every refusal, so a human can run it verbatim', () => {
    const outcome = runRecipe(specFor('brew').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawnOk(),
      mcpMode: notInMcp,
    })

    expect(outcome.commands).toHaveLength(1)
    expect(outcome.commands[0]).toContain('install.sh')
  })
})

describe('the child environment', () => {
  it('pins cwd to the home directory, so no repo’s .npmrc can redirect the registry', () => {
    const spawn = spawnOk()

    runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, { spawnSync: spawn, mcpMode: notInMcp })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: homedir() })
  })

  it('scrubs every variable that would change how Homebrew’s installer behaves', () => {
    const spawn = spawnOk()
    const env = {
      PATH: '/usr/bin',
      NONINTERACTIVE: '1',
      CI: '1',
      INTERACTIVE: '0',
      HAVE_SUDO_ACCESS: '1',
      SUDO_ASKPASS: '/opt/fixture/askpass',
    }

    runRecipe(specFor('gh').bootstrapInstall, BREW_PRESENT, { spawnSync: spawn, env, mcpMode: notInMcp })

    const childEnv = (spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env

    for (const key of ['NONINTERACTIVE', 'CI', 'INTERACTIVE', 'HAVE_SUDO_ACCESS', 'SUDO_ASKPASS']) {
      expect({ key, value: childEnv[key] }).toEqual({ key, value: undefined })
    }
  })

  it('does not pass the caller’s environment through untouched', () => {
    const spawn = spawnOk()
    const env = { PATH: '/usr/bin', npm_config_registry: 'https://evil.example' }

    runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, { spawnSync: spawn, env, mcpMode: notInMcp })

    const childEnv = (spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env

    expect(childEnv).not.toBe(env)
  })
})

describe('multi-step recipes', () => {
  it('runs doppler’s gnupg prerequisite before the tap install', () => {
    const spawn = spawnOk()

    runRecipe(specFor('doppler').bootstrapInstall, BREW_PRESENT, { spawnSync: spawn, mcpMode: notInMcp })

    expect(
      spawn.mock.calls.map((call) => {
        return call[1]
      }),
    ).toEqual([
      ['install', 'gnupg'],
      ['install', 'dopplerhq/cli/doppler'],
    ])
  })

  it('stops at the first failing step rather than pressing on', () => {
    // A doppler "install" that skipped gnupg is an install without signature verification — the worst
    // outcome available, and strictly worse than reporting a failure.
    const spawn = vi.fn().mockReturnValueOnce({ status: 1, signal: null, error: undefined }).mockReturnValue(ok)

    const outcome = runRecipe(specFor('doppler').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn as never,
      mcpMode: notInMcp,
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ ran: true, ok: false, failedStep: 'brew install gnupg' })
  })
})

describe('failure reporting', () => {
  it('names a missing binary rather than collapsing it into an exit code', () => {
    const spawn = vi.fn().mockReturnValue({ status: null, signal: null, error: new Error('spawn ENOENT') })
    const outcome = runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn as never,
      mcpMode: notInMcp,
    })

    expect(outcome).toMatchObject({ ran: true, ok: false })
    expect(outcome.ran === true && outcome.detail).toContain('could not start')
  })

  it('never retries under sudo after a permission failure', () => {
    const spawn = vi.fn().mockReturnValue({ status: 243, signal: null, error: undefined })

    runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, { spawnSync: spawn as never, mcpMode: notInMcp })

    expect(spawn).toHaveBeenCalledTimes(1)
    for (const call of spawn.mock.calls) expect(call[0]).not.toBe('sudo')
  })
})
