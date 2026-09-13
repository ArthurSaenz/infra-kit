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

/** Swallow the per-step narration. Production sends it to the logger; a test run is not the place for it. */
const silent = (): void => {}

describe('recipe safety and caller authority are separate refusals', () => {
  it('never spawns the Homebrew bootstrap, even from a CLI with a human present', () => {
    const spawn = spawnOk()
    const outcome = runRecipe(specFor('brew').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn,
      mcpMode: notInMcp,
      notify: silent,
    })

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
      notify: silent,
    })

    expect(outcome.commands).toHaveLength(1)
    expect(outcome.commands[0]).toContain('install.sh')
  })
})

describe('the child environment', () => {
  it('pins cwd to the home directory, so no repo’s .npmrc can redirect the registry', () => {
    const spawn = spawnOk()

    runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn,
      mcpMode: notInMcp,
      notify: silent,
    })

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

    runRecipe(specFor('gh').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn,
      env,
      mcpMode: notInMcp,
      notify: silent,
    })

    const childEnv = (spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env

    for (const key of ['NONINTERACTIVE', 'CI', 'INTERACTIVE', 'HAVE_SUDO_ACCESS', 'SUDO_ASKPASS']) {
      expect({ key, value: childEnv[key] }).toEqual({ key, value: undefined })
    }
  })

  it('does not pass the caller’s environment through untouched', () => {
    const spawn = spawnOk()
    const env = { PATH: '/usr/bin', npm_config_registry: 'https://evil.example' }

    runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn,
      env,
      mcpMode: notInMcp,
      notify: silent,
    })

    const childEnv = (spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env

    expect(childEnv).not.toBe(env)
  })
})

describe('the child’s output', () => {
  it('is captured, never inherited — the summary is the only thing that writes to the terminal', () => {
    const spawn = spawnOk()

    runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn,
      mcpMode: notInMcp,
      notify: silent,
    })

    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] })
  })

  it('announces each step before running it, so a slow install is not silence', () => {
    const said: string[] = []

    runRecipe(specFor('doppler').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawnOk(),
      mcpMode: notInMcp,
      notify: (line) => {
        said.push(line.trim())
      },
    })

    expect(said).toEqual(['running   brew install gnupg', 'running   brew install dopplerhq/cli/doppler'])
  })
})

describe('multi-step recipes', () => {
  it('runs doppler’s gnupg prerequisite before the tap install', () => {
    const spawn = spawnOk()

    runRecipe(specFor('doppler').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn,
      mcpMode: notInMcp,
      notify: silent,
    })

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
      notify: silent,
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
      notify: silent,
    })

    expect(outcome).toMatchObject({ ran: true, ok: false })
    expect(outcome.ran === true && outcome.detail).toContain('could not start')
  })

  // Output is captured rather than inherited, so this is the only route by which a failing installer's
  // own sentence still reaches the report. Without it the `aws update` failure that motivated all this
  // read `exited 252` and threw away the line that said why.
  it('carries the child’s own last words, not just the exit code', () => {
    const stderr = ['downloading…', '', "aws: [ERROR]: argument command: Found invalid choice 'update'"].join('\n')
    const spawn = vi.fn().mockReturnValue({ status: 252, signal: null, error: undefined, stdout: '', stderr })

    const outcome = runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn as never,
      mcpMode: notInMcp,
      notify: silent,
    })

    expect(outcome.ran === true && outcome.detail).toContain('exited 252')
    expect(outcome.ran === true && outcome.detail).toContain("Found invalid choice 'update'")
  })

  it('falls back to stdout when the child said nothing on stderr', () => {
    const spawn = vi.fn().mockReturnValue({ status: 1, signal: null, error: undefined, stdout: 'nope\n', stderr: '' })

    const outcome = runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn as never,
      mcpMode: notInMcp,
      notify: silent,
    })

    expect(outcome.ran === true && outcome.detail).toBe('exited 1: nope')
  })

  // brew writes `==> Downloading` progress to STDERR and its diagnosis to stdout, so a rule that simply
  // preferred a non-empty stderr would report the progress and drop the reason.
  it('prefers the error-shaped line over whichever stream happens to be non-empty', () => {
    const spawn = vi.fn().mockReturnValue({
      status: 1,
      signal: null,
      error: undefined,
      stderr: '==> Downloading foo\n==> Pouring foo\n',
      stdout: 'Error: no bottle available for foo\n',
    })

    const outcome = runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn as never,
      mcpMode: notInMcp,
      notify: silent,
    })

    expect(outcome.ran === true && outcome.detail).toBe('exited 1: Error: no bottle available for foo')
  })

  // `npm ERR! code E404` ends its keyword in `!`, a non-word character, so a `\b` placed after the
  // whole alternation could never be satisfied there and the alternative was dead on arrival.
  it('recognises the npm ERR! prefix as the failure line', () => {
    const spawn = vi.fn().mockReturnValue({
      status: 1,
      signal: null,
      error: undefined,
      stderr: 'npm WARN deprecated foo\nnpm ERR! code E404\nnpm ERR! 404 Not Found\n',
      stdout: 'added 1 package\n',
    })

    const outcome = runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn as never,
      mcpMode: notInMcp,
      notify: silent,
    })

    expect(outcome.ran === true && outcome.detail).toBe('exited 1: npm ERR! code E404 / npm ERR! 404 Not Found')
  })

  // At the ceiling `spawnSync` SIGTERMs a child that started perfectly well and returns an `error`. The
  // generic `error` branch would call that "could not start", the one description guaranteed to be false.
  it('names the output ceiling rather than reporting a killed install as a failure to start', () => {
    const spawn = vi.fn().mockReturnValue({
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync brew ENOBUFS'), { code: 'ENOBUFS' }),
      stdout: 'x'.repeat(64),
      stderr: '',
    })

    const outcome = runRecipe(specFor('gh').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn as never,
      mcpMode: notInMcp,
      notify: silent,
    })

    expect(outcome.ran === true && outcome.detail).toContain('output limit')
    expect(outcome.ran === true && outcome.detail).not.toContain('could not start')
  })

  it('caps how much of a chatty install it will hold in memory', () => {
    const spawn = spawnOk()

    runRecipe(specFor('gh').bootstrapInstall, BREW_PRESENT, { spawnSync: spawn, mcpMode: notInMcp, notify: silent })

    // Node's 1 MiB default is not a truncation — it KILLS the child, which a `brew install` building
    // from source would trip routinely.
    const { maxBuffer } = spawn.mock.calls[0]?.[2] as { maxBuffer: number }

    expect(maxBuffer).toBeGreaterThan(1024 * 1024)
  })

  // An unanchored `\berror\b` matches inside a package name, and brew names one on every download line.
  it('does not mistake a progress line naming a package for the diagnosis', () => {
    const spawn = vi.fn().mockReturnValue({
      status: 1,
      signal: null,
      error: undefined,
      stderr: '==> Downloading error-prone-2.36.0.arm64_sonoma.bottle.tar.gz\n',
      stdout: 'Error: no bottle available\n',
    })

    const outcome = runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn as never,
      mcpMode: notInMcp,
      notify: silent,
    })

    expect(outcome.ran === true && outcome.detail).toBe('exited 1: Error: no bottle available')
  })

  // The fallback ranks one STREAM, not the concatenation: the tail of `[...stderr, ...stdout]` is
  // always stdout's, which would drop an unlabelled stderr diagnosis behind any stdout chatter.
  it('keeps an unlabelled stderr diagnosis rather than the tail of a chatty stdout', () => {
    const spawn = vi.fn().mockReturnValue({
      status: 1,
      signal: null,
      error: undefined,
      stderr: 'could not reach the signing server\n',
      stdout: ['step 1', 'step 2', 'step 3', 'step 4', 'step 5', 'step 6'].join('\n'),
    })

    const outcome = runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn as never,
      mcpMode: notInMcp,
      notify: silent,
    })

    expect(outcome.ran === true && outcome.detail).toBe('exited 1: could not reach the signing server')
  })

  it('never retries under sudo after a permission failure', () => {
    const spawn = vi.fn().mockReturnValue({ status: 243, signal: null, error: undefined })

    runRecipe(specFor('portless').bootstrapInstall, BREW_PRESENT, {
      spawnSync: spawn as never,
      mcpMode: notInMcp,
      notify: silent,
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    for (const call of spawn.mock.calls) expect(call[0]).not.toBe('sudo')
  })
})
