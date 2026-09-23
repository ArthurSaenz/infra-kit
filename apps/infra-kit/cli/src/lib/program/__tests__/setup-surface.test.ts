import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initCore } from 'src/commands/init'
import { resolveLeaf } from 'src/lib/command-catalog/palette'
import { runRecipe } from 'src/lib/dependency-install'
import type { InstallOutcome } from 'src/lib/dependency-install'
import { probeAll } from 'src/lib/dependency-probe'
import type { DependencyState } from 'src/lib/dependency-probe'
import { buildProgram } from 'src/lib/program'

/**
 * @fileoverview
 *
 * The Commander half of the two-command surface: what `setup` and `doctor` resolve to, what no longer
 * resolves at all, and — the load-bearing one — what running each of them can reach.
 *
 * `lib/dependency-install` is mocked at the MODULE boundary rather than through `setup`'s injectable
 * `run` seam, because "installs nothing" is the invariant under test and a test asserting it against an
 * injected fake would pass on a build that ignored the injection. Driving through `parseAsync` rather
 * than calling the actions directly is the other half of that: the wiring in `program.ts` IS the thing
 * being pinned, so a test that imported `setup` and called it with `{ skipTools: true }` would keep
 * passing on a build where the FLAG never reaches that argument.
 */

vi.mock('src/commands/init', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/commands/init')>()

  // Only the core is faked, so everything `setup` does around it still runs. `initCore`'s own writes
  // (.zshrc, the plugin install) all live below this seam.
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

vi.mock('src/lib/dependency-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/dependency-probe')>()

  return { ...actual, probeAll: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { level: 'info', info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const aState = (over: Partial<DependencyState> & { id: DependencyState['id'] }): DependencyState => {
  return { present: true, onPath: true, binRealPath: null, version: '1.0.0', manager: 'homebrew', ...over }
}

/**
 * brew present so the risk predicate has a manager to install WITH, gh absent so it is the one tool that
 * must be INSTALLED, and the remaining three parked on `manager: 'unknown'` — which plans as `none`, so
 * they contribute no recipe at all. brew itself still plans an `update`, which is why the assertions
 * below name gh's recipe rather than counting calls.
 */
const oneToolMissing = (): DependencyState[] => {
  return [
    aState({ id: 'brew' }),
    aState({ id: 'git', manager: 'unknown' }),
    aState({ id: 'gh', present: false, onPath: false, version: null, manager: 'unknown' }),
    aState({ id: 'aws', manager: 'unknown' }),
    aState({ id: 'doppler', manager: 'unknown' }),
    aState({ id: 'portless', manager: 'unknown' }),
  ]
}

/** Run the real registered command exactly as argv would reach it. */
const run = async (argv: string[]): Promise<void> => {
  await buildProgram().parseAsync(argv, { from: 'user' })
}

const originalExitCode = process.exitCode

beforeEach(() => {
  vi.clearAllMocks()
  process.exitCode = undefined
  vi.mocked(initCore).mockResolvedValue([])
  vi.mocked(probeAll).mockResolvedValue(oneToolMissing())
})

afterEach(() => {
  process.exitCode = originalExitCode
})

// I-1. `palette.ts` SKIPS a catalog entry whose groupPath resolves to nothing, silently — so a stale
// registration left behind, or a new one never added, is invisible to every other surface test.
describe('the Commander surface is exactly the two commands', () => {
  it('resolves setup and doctor as real leaves', () => {
    const commands = buildProgram().commands

    for (const name of ['setup', 'doctor']) {
      const leaf = resolveLeaf(commands, [name])

      expect(leaf, `${name} must resolve to a Commander leaf`).toBeDefined()
      expect(leaf?.commands, `${name} must be a runnable leaf, not a group`).toHaveLength(0)
    }
  })

  // Reds on: leaving any of the three registrations behind after folding them into `setup`.
  it('resolves none of the three setup-dependency paths', () => {
    const commands = buildProgram().commands

    for (const name of ['setup-dependency', 'setup-dependency-update', 'setup-dependency-status']) {
      expect(resolveLeaf(commands, [name]), `${name} must no longer be registered`).toBeUndefined()
    }
  })

  // `setup` carries all three flags. Commander throws on an unknown option (nothing in this CLI opts
  // into `allowUnknownOption`), so parsing each one IS the assertion that it is declared.
  it('declares --tools, --update and --skip-tools on setup', () => {
    const flags = resolveLeaf(buildProgram().commands, ['setup'])
      ?.options.map((option) => {
        return option.long
      })
      .filter(Boolean)

    expect(flags).toEqual(expect.arrayContaining(['--tools', '--update', '--skip-tools']))
  })
})

// I-3 + U-S5, the two halves of what used to be the stale-guidance invariant. `init` is gone outright,
// so the subject is now `setup --skip-tools` alone: it is the ONE spelling that does the additive local
// writes and installs nothing, and it is what every stale "set this repo up" instruction gets redirected
// to. The invariant is that this spelling never acquires an installer.
describe('setup --skip-tools is the additive path, and init is gone', () => {
  // Reds on: re-registering `init`, hidden or not. `resolveLeaf` finds hidden commands too, so this
  // cannot be satisfied by hiding one.
  it('resolves no init command at all', () => {
    expect(resolveLeaf(buildProgram().commands, ['init'])).toBeUndefined()
    expect(
      buildProgram().commands.filter((command) => {
        return command.name() === 'init'
      }),
    ).toEqual([])
  })

  // U-S5. Stated over BEHAVIOUR, not over which function is called: an implementation that shares one
  // function with flagless `setup` must still pass this. What must not happen is a reachable installer.
  // Reds on: dropping `--skip-tools` from the action's options, or letting it fall through to the
  // flagless path.
  it('installs nothing — never reaches lib/dependency-install', async () => {
    await run(['setup', '--skip-tools'])

    expect(vi.mocked(runRecipe)).not.toHaveBeenCalled()
  })

  // The positive control. Without it the assertion above is green on a build where the installer is
  // unreachable from EVERY command — which would hide the bug it exists to catch rather than find it.
  //
  // Asserted on the ABSENT tool's recipe rather than on a call count: the same fixture also has brew
  // present under a manager we update, so flagless `setup` legitimately runs more than one recipe and a
  // count would pin the fixture instead of the behaviour.
  it('while flagless setup DOES reach it, for the tool that is missing', async () => {
    await run(['setup'])

    const installed = vi.mocked(runRecipe).mock.calls.flatMap((call) => {
      return (call[0] as { steps: string[][] }).steps.map((step) => {
        return step.join(' ')
      })
    })

    expect(vi.mocked(runRecipe)).toHaveBeenCalled()
    expect(installed.join('\n')).toContain('gh')
  })

  // The other half of "gone": Commander must REFUSE the old name at PARSE time rather than fall through
  // to some default. Reds on: an `init` alias, or a hidden re-registration that `resolveLeaf` above
  // would catch but that a reader might assume is still "supported".
  //
  // `exitOverride` rather than the shared `run` helper, because the real program has none: an unparsed
  // command makes Commander call `process.exit(1)`, which would take the vitest worker with it.
  it('rejects `init` as an unknown command', async () => {
    const program = buildProgram().exitOverride()

    program.configureOutput({ writeErr: () => {} })

    await expect(program.parseAsync(['init'], { from: 'user' })).rejects.toThrow(/unknown command/iu)
  })
})
