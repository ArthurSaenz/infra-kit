import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { commandCatalog } from 'src/lib/command-catalog'
import { resolveLeaf } from 'src/lib/command-catalog/palette'
import { commandEcho } from 'src/lib/command-echo'
import { runEnvAutoLoad, surfaceStickyAuthFailure } from 'src/lib/env-autoload'
import { logger } from 'src/lib/logger'

import { buildProgram, commandPath } from '../program'

// The preAction hook's other two legs touch the outside world: the layer-3 seed writes to $HOME and the
// auto-load shells out to Doppler. Neither is under test here, and a test that seeds a real home dir is
// a test that changes the machine it runs on.
vi.mock('src/lib/config-bootstrap', () => {
  return { ensureUserProjectConfig: vi.fn(async () => {}) }
})

vi.mock('src/lib/env-autoload', () => {
  return { runEnvAutoLoad: vi.fn(async () => {}), surfaceStickyAuthFailure: vi.fn() }
})

/** Every catalog command that is a runnable leaf — skips the bare `vendor`/`config` group nodes. */
const leafEntries = () => {
  return commandCatalog.filter((entry) => {
    const leaf = resolveLeaf(buildProgram().commands, entry.groupPath)

    return leaf !== undefined && leaf.commands.length === 0
  })
}

/**
 * Parse `argv` against a real program whose target leaf has had its action swapped for a no-op, so the
 * command's own side effects (deploying, deleting worktrees) never run while every Commander hook still
 * fires exactly as it does in production. Re-calling `.action()` replaces the handler.
 *
 * Required positional arguments are filled with a placeholder, read off Commander's own
 * `registeredArguments` rather than a hardcoded per-command list. Without it, a command that takes one
 * (`env-token-set <env>`) would make Commander call `process.exit(1)` on a missing argument, and the
 * guard below would fail on a command that is perfectly well-formed. The value is never read — the
 * action is inert — so any token will do.
 */
const parseWithInertAction = async (groupPath: string[]): Promise<void> => {
  const program = buildProgram()
  const leaf = resolveLeaf(program.commands, groupPath)!

  leaf.action(() => {})

  const requiredArgs = leaf.registeredArguments
    .filter((argument) => {
      return argument.required
    })
    .map(() => {
      return 'placeholder'
    })

  await program.parseAsync(['node', 'infra-kit', ...groupPath, ...requiredArgs])
}

afterEach(() => {
  vi.restoreAllMocks()
  commandEcho.reset()
})

describe('program — the equivalent-command line is bound by Commander', () => {
  /**
   * The regression this pins: commands used to name their own echo, hardcoding the FLAT `release-create`.
   * When the flat aliases were dropped, `pnpm exec infra-kit release-create …` stopped parsing — so the
   * "📟 Equivalent command" we printed after an interactive run was a command the CLI would reject.
   *
   * Driven from the catalog rather than a list of names, so a command added or regrouped tomorrow is
   * covered without touching this test — which is the only way the guard stays honest.
   */
  it('binds the echo to the grouped path Commander parsed, for every catalog leaf', async () => {
    for (const entry of leafEntries()) {
      const expected = entry.groupPath.join(' ')
      const startSpy = vi.spyOn(commandEcho, 'start')

      await parseWithInertAction(entry.groupPath)

      expect(startSpy, `"${expected}" never bound the echo`).toHaveBeenCalledWith(expected)

      startSpy.mockRestore()
    }
  })

  // The end of the chain: what gets PRINTED is the argv, so a user can retype the line and have it run.
  it('prints a replay line whose command is the grouped path, not a flat name', async () => {
    const infoSpy = vi.spyOn(logger, 'info')

    await parseWithInertAction(['release', 'create'])

    commandEcho.setInteractive()
    commandEcho.addOption('--yes', true)
    commandEcho.print()

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('pnpm exec infra-kit release create --yes'))
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('release-create'))
  })

  // `commandPath()` is what the hook feeds the echo, and `groupPath` is what every menu surface spawns.
  // If those two ever disagree, the printed line and the menu would run different commands.
  it('agrees with the catalog groupPath for every leaf', () => {
    const program = buildProgram()

    for (const entry of leafEntries()) {
      const leaf = resolveLeaf(program.commands, entry.groupPath)!

      expect(commandPath(leaf)).toBe(entry.groupPath.join(' '))
    }
  })
})

/** Every `.ts` file under `src`, excluding tests. */
const sourceFiles = (dir: string): string[] => {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full)

    return entry.isFile() && full.endsWith('.ts') ? [full] : []
  })
}

/**
 * Command invocations we tell the user to type, harvested from the source.
 *
 * Anchored on the repo's convention for naming a command to a human: a BACKTICK code span —
 * ``run `infra-kit vendor config --init` `` — optionally via `pnpm exec`. The backtick is what separates
 * an invocation from prose that merely mentions the binary (doctor.ts's `'infra-kit shell block missing'`
 * is a status label, not something to type), and anchoring on it is why this scan needs no exception list.
 *
 * Anything that isn't a literal command token is dropped rather than guessed at: a flag, an
 * `${interpolation}` or a `<placeholder>` ends the run, so `infra-kit --help` yields nothing.
 *
 * The convention is load-bearing: an invocation written WITHOUT backticks is invisible here and therefore
 * unguarded. Write it in backticks.
 *
 * @example
 * invocationsIn('run `infra-kit worktrees list` first') // => [['worktrees', 'list']]
 */
const invocationsIn = (source: string): string[][] => {
  const matches = source.matchAll(/`(?:pnpm exec\s+)?(?:infra-kit|ik)\s+([^`\n]*)/gu)

  return [...matches].flatMap((match) => {
    const tokens: string[] = []

    for (const token of (match[1] ?? '').split(/\s+/u)) {
      // A flag, an interpolation or a placeholder ends the command — everything after it is arguments.
      if (!/^[a-z][a-z0-9-]*$/u.test(token)) break

      tokens.push(token)
    }

    return tokens.length > 0 ? [tokens] : []
  })
}

describe('program — every command we print is a command we accept', () => {
  /**
   * The bug class behind FOUR separate regressions: a user-facing string names a command the CLI does not
   * parse. It bit the `📟` replay line (`release-create`), the vendor factory-config error — which is the
   * FIRST thing a new user sees, and it sent them to a dead `vendor-config --init` — and two more.
   *
   * Each one compiled, passed its own tests, and shipped a dead end. Nothing but this scan can catch them,
   * because a hand-authored name is checked by no type and no parser. With an empty README, these strings
   * ARE this CLI's documentation, so a stale one is a documentation outage.
   */
  it('resolves every `infra-kit <command>` string in the source to a real command', () => {
    const src = path.resolve(__dirname, '../../..')
    const program = buildProgram()

    const dead = sourceFiles(src).flatMap((file) => {
      return invocationsIn(readFileSync(file, 'utf8'))
        .filter((tokens) => {
          return resolveLeaf(program.commands, tokens) === undefined
        })
        .map((tokens) => {
          return `${path.relative(src, file)}: infra-kit ${tokens.join(' ')}`
        })
    })

    expect(dead).toEqual([])
  })

  // Guards the guard: a regex that silently stops matching would make the scan above vacuously green.
  it('actually harvests invocations — and drops the things that only look like one', () => {
    expect(invocationsIn('run `infra-kit vendor config --init` to scaffold')).toEqual([['vendor', 'config']])
    expect(invocationsIn('`pnpm exec infra-kit release create`')).toEqual([['release', 'create']])
    expect(invocationsIn('`infra-kit --help`')).toEqual([])
    expect(invocationsIn(`\`infra-kit \${cliPath} \${flags}\``)).toEqual([])
    // Prose that names the binary is not an instruction to type it.
    expect(invocationsIn("'infra-kit shell block missing from ~/.zshrc'")).toEqual([])
  })

  // The scan is worthless if it matches nothing. It found the three dead strings that shipped in this
  // branch, so it must keep finding the live ones they became.
  it('harvests a meaningful number of invocations from the real source tree', () => {
    const src = path.resolve(__dirname, '../../..')

    const found = sourceFiles(src).flatMap((file) => {
      return invocationsIn(readFileSync(file, 'utf8'))
    })

    expect(found.length).toBeGreaterThan(3)
  })
})

describe('program — the sticky auth-failure warning is not gated by the auto-load exclusion', () => {
  /**
   * The second half of the silent-token bug. `version`, `doctor` and `dev` are excluded from the
   * cli-invocation auto-LOAD on purpose (priming Doppler env there would be surprising) — but they are
   * exactly what a user whose shell env went quiet runs next. Replaying the recorded token failure is
   * WARNING, not LOADING, so it must fire on every command, including the excluded ones. Gated on the
   * same set, a `dev`-only user would be warned by nothing, ever.
   */
  beforeEach(() => {
    vi.mocked(runEnvAutoLoad).mockClear()
    vi.mocked(surfaceStickyAuthFailure).mockClear()
  })

  it('replays on an auto-load-EXCLUDED command (version), which still never auto-loads', async () => {
    await parseWithInertAction(['version'])

    expect(surfaceStickyAuthFailure).toHaveBeenCalled()
    expect(runEnvAutoLoad).not.toHaveBeenCalled()
  })

  it('replays on a non-excluded command too (which does auto-load)', async () => {
    await parseWithInertAction(['worktrees', 'list'])

    expect(surfaceStickyAuthFailure).toHaveBeenCalled()
    expect(runEnvAutoLoad).toHaveBeenCalledWith(expect.objectContaining({ expectedTrigger: 'cli-invocation' }))
  })
})
