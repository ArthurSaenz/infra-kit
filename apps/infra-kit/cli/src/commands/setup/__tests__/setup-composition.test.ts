import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { InitStepError, initCore } from 'src/commands/init'
import type { InitEntry, InitStepSink } from 'src/commands/init'
import { setup } from 'src/commands/setup'
import { runRecipe } from 'src/lib/dependency-install'
import type { InstallOutcome } from 'src/lib/dependency-install'
import type { ProbeDeps } from 'src/lib/dependency-probe'
import { logger } from 'src/lib/logger'

/**
 * How `setup` composes its two halves, and what it refuses to do.
 *
 * The init half is mocked here so the suite can drive states a real machine cannot be put into on
 * demand (a step that throws); `setup-init-report.test.ts` runs the real one. The DEPENDENCY half is
 * mocked at `lib/dependency-install`, the module boundary, rather than through `setup`'s injectable
 * `run` seam — because "never reaches the installer" is the invariant under test, and a test that
 * asserted it against an injected fake would pass on a build that ignored the injection.
 */

vi.mock('src/commands/init', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/commands/init')>()

  return { ...actual, initCore: vi.fn() }
})

vi.mock('src/lib/dependency-install', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/dependency-install')>()

  return {
    ...actual,
    runRecipe: vi.fn((recipe: { steps: string[][] }): InstallOutcome => {
      return {
        ran: true,
        ok: true,
        commands: recipe.steps.map((step) => {
          return step.join(' ')
        }),
      }
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

/** A machine where brew and gh are installed via Homebrew, and everything else is absent. */
const brewAndGhInstalled = (): ProbeDeps => {
  const kegs: Record<string, string> = {
    brew: '/opt/homebrew/bin/brew',
    gh: '/opt/homebrew/Cellar/gh/2.60.0/bin/gh',
  }

  return {
    runCommand: async (argv) => {
      const bin = argv[0] as string

      if (kegs[bin] === undefined) throw new Error('not found')

      return { stdout: `${bin} version 1.2.3` }
    },
    resolveBinPath: async (binName) => {
      return kegs[binName] ?? null
    },
    realpath: (candidate) => {
      return candidate
    },
    platform: 'darwin',
  }
}

const anEntry = (over: Partial<InitEntry> = {}): InitEntry => {
  return { step: 'zshrc', outcome: 'written', message: 'Added infra-kit shell functions', level: 'info', ...over }
}

/** An init half that reports one entry and succeeds. */
const initReports = (...entries: InitEntry[]): void => {
  vi.mocked(initCore).mockImplementation(async (onStep?: InitStepSink) => {
    for (const entry of entries) onStep?.(entry)

    return entries
  })
}

const infoLines = (): string[] => {
  return vi.mocked(logger.info).mock.calls.map((call) => {
    return typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0])
  })
}

const resultFor = <T extends { id: string }>(tools: T[], id: string): T | undefined => {
  return tools.find((tool) => {
    return tool.id === id
  })
}

const originalExitCode = process.exitCode

beforeEach(() => {
  vi.clearAllMocks()
  process.exitCode = undefined
  initReports(anEntry())
})

afterEach(() => {
  process.exitCode = originalExitCode
})

describe('setup runs both halves, in order, whatever the first one does', () => {
  // Reds on: reordering the two halves in `setup()`.
  it('runs the init half before the dependency step', async () => {
    await setup({ probeDeps: brewAndGhInstalled(), tools: ['gh'] })

    const initOrder = vi.mocked(initCore).mock.invocationCallOrder[0] as number
    const runOrder = vi.mocked(runRecipe).mock.invocationCallOrder[0] as number

    expect(vi.mocked(initCore)).toHaveBeenCalledTimes(1)
    expect(initOrder).toBeLessThan(runOrder)
  })

  // Reds on: short-circuiting the dependency step when the init half reports a warning.
  it('still converges when the init half only warned', async () => {
    initReports(anEntry({ step: 'plugin-pointer', outcome: 'warned', message: 'could not install', level: 'warn' }))

    const { structuredContent } = await setup({ probeDeps: brewAndGhInstalled(), tools: ['gh'] })

    expect(resultFor(structuredContent.tools, 'gh')).toMatchObject({ action: 'updated' })
    expect(structuredContent.init).toEqual([
      { step: 'plugin-pointer', outcome: 'warned', message: 'could not install' },
    ])
  })

  // Reds on: `return`ing on the init half's failure, or leaving the exit code at 0 when it fails.
  it('runs the dependency step after an init-half THROW, and exits non-zero', async () => {
    vi.mocked(initCore).mockRejectedValue(new InitStepError('user-config', new Error('EACCES: read-only file system')))

    const { structuredContent } = await setup({ probeDeps: brewAndGhInstalled(), tools: ['gh'] })

    expect(vi.mocked(runRecipe)).toHaveBeenCalledTimes(1)
    expect(resultFor(structuredContent.tools, 'gh')).toMatchObject({ action: 'updated' })
    expect(structuredContent.init).toEqual([
      { step: 'user-config', outcome: 'warned', message: expect.stringContaining('EACCES') as unknown as string },
    ])
    expect(process.exitCode).toBe(1)
  })
})

describe('a refusal is not a failure, and a failure is not a refusal', () => {
  // Reds on: reporting a risk-predicate refusal as `failed` (allSucceeded would flip to false).
  it('reports a refused recipe as succeeded, and prints the argv a human has to run', async () => {
    const { structuredContent } = await setup({ probeDeps: brewAndGhInstalled(), tools: ['aws'] })

    expect(resultFor(structuredContent.tools, 'aws')).toMatchObject({ action: 'refused' })
    expect(structuredContent.allSucceeded).toBe(true)
    expect(structuredContent.changed).toBe(false)
    expect(process.exitCode ?? 0).toBe(0)
    // The commands are the point of a refusal: printed, for the human, never run.
    expect(infoLines().join('\n')).toContain('install.sh')
    expect(vi.mocked(runRecipe)).not.toHaveBeenCalled()
  })

  // Reds on: reporting a real install failure as anything but `failed` / exit 0 on a failed install.
  it('reports a failing step as failed, and exits non-zero', async () => {
    vi.mocked(runRecipe).mockReturnValueOnce({
      ran: true,
      ok: false,
      commands: ['brew install gnupg'],
      failedStep: 'brew install gnupg',
      detail: 'exited 1',
    })

    const { structuredContent } = await setup({ probeDeps: brewAndGhInstalled(), tools: ['doppler'] })

    expect(resultFor(structuredContent.tools, 'doppler')).toMatchObject({ action: 'failed' })
    expect(structuredContent.allSucceeded).toBe(false)
    expect(process.exitCode).toBe(1)
  })
})

describe('--update updates what is present and never installs what is absent', () => {
  // Reds on: dropping `update` in the merge, which silently turns update-only into converge.
  it('updates the present tool and skips the absent one, naming why', async () => {
    const { structuredContent } = await setup({ probeDeps: brewAndGhInstalled(), update: true })
    const handed = vi.mocked(runRecipe).mock.calls.flatMap((call) => {
      return call[0].steps.map((step) => {
        return step.join(' ')
      })
    })

    expect(resultFor(structuredContent.tools, 'gh')).toMatchObject({ action: 'updated' })
    expect(resultFor(structuredContent.tools, 'doppler')).toMatchObject({ action: 'skipped' })
    expect(resultFor(structuredContent.tools, 'doppler')?.detail).toContain('only updates')
    // The absent tool's INSTALL recipe never reached the executor — the converge path would have run it.
    expect(handed).not.toContain('brew install dopplerhq/cli/doppler')
    expect(handed).toContain('brew upgrade gh')
  })

  // Reds on: ignoring the ids carried by `--update <ids...>` and converging the whole registry.
  it('narrows to the ids the flag carried', async () => {
    const { structuredContent } = await setup({ probeDeps: brewAndGhInstalled(), update: ['doppler'] })

    expect(
      structuredContent.tools.map((tool) => {
        return tool.id
      }),
    ).toEqual(['doppler'])
    expect(structuredContent.changed).toBe(false)
  })
})

describe('--skip-tools installs nothing, and cannot be talked into installing something', () => {
  // Reds on: making --skip-tools a no-op flag (it would converge, calling the installer).
  it('never reaches lib/dependency-install, and reports what each tool needs instead', async () => {
    const { structuredContent } = await setup({ probeDeps: brewAndGhInstalled(), skipTools: true })

    expect(vi.mocked(runRecipe)).not.toHaveBeenCalled()
    expect(structuredContent.converged).toBe(false)
    expect(structuredContent.changed).toBe(false)
    expect(resultFor(structuredContent.tools, 'doppler')).toMatchObject({ action: 'skipped' })
    expect(resultFor(structuredContent.tools, 'doppler')?.detail).toContain('would install')
    // The argv that would fix it is printed, which is the whole point of the probe.
    expect(infoLines().join('\n')).toContain('brew install dopplerhq/cli/doppler')
  })

  // Reds on: letting --tools or --update silently override --skip-tools instead of refusing.
  it('refuses --skip-tools with --tools, and installs nothing on the way out', async () => {
    await expect(setup({ probeDeps: brewAndGhInstalled(), skipTools: true, tools: ['doppler'] })).rejects.toThrow(
      /cannot be combined/,
    )

    expect(vi.mocked(runRecipe)).not.toHaveBeenCalled()
    expect(vi.mocked(initCore)).not.toHaveBeenCalled()
  })

  it('refuses --skip-tools with --update, and installs nothing on the way out', async () => {
    await expect(setup({ probeDeps: brewAndGhInstalled(), skipTools: true, update: true })).rejects.toThrow(
      /cannot be combined/,
    )

    expect(vi.mocked(runRecipe)).not.toHaveBeenCalled()
  })

  /**
   * What makes `--skip-tools` safe to carry an invariant at all: a misspelling is a hard error, never a
   * silently-dropped flag. Commander errors on an unknown option unless a command opts out with
   * `allowUnknownOption`, so this asserts the CLI has no such opt-out anywhere.
   *
   * Reds on: adding `allowUnknownOption()` to `program.ts` or any command — after which
   * `infra-kit setup --skip-tool` (one letter short) would parse as flagless `setup` and INSTALL.
   */
  it('fails closed on a misspelled flag: no command anywhere opts out of unknown-option errors', () => {
    const root = path.resolve(import.meta.dirname, '../../..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name)

        // `__tests__` is excluded because this very file names the string it is looking for; the
        // invariant is about the command wiring, and no test registers a command.
        if (item.isDirectory() && item.name !== 'node_modules' && item.name !== '__tests__') walk(full)
        else if (item.isFile() && full.endsWith('.ts') && fs.readFileSync(full, 'utf-8').includes('allowUnknownOption'))
          offenders.push(path.relative(root, full))
      }
    }

    walk(root)

    expect(offenders).toEqual([])
  })
})
