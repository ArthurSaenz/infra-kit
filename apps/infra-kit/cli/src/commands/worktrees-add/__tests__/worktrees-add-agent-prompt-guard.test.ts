import { Buffer } from 'node:buffer'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { findOrcaRepo, probeOrca } from 'src/integrations/orca'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { zxCommandMock } from 'src/lib/git-utils/__tests__/zx-command-mock'
import { getInfraKitConfig, resolveConfiguredIdes, resolveOrcaLayout } from 'src/lib/infra-kit-config'

import { worktreesAdd } from '../worktrees-add'

/**
 * G0g — the two "open it in X?" follow-ups in `worktrees-add`, driven through the REAL
 * exported command.
 *
 * @example
 * // --agent, no flags, no config keys => both resolve false, stdout stays byte-for-byte empty
 * await worktreesAdd({ confirmedCommand: true, versions: '1.2.5' })
 */

// WHAT THIS GUARDS — under `--agent --json` a `worktrees add --yes` carrying `versions` or
// `all` runs end to end, and stdout is the JSON result the skill parses. With neither the
// flag nor the config key set, both follow-ups used to fall through to
// `withEscape(confirm(…))`, and `@inquirer` renders to `process.stdout`: two prompts, a
// corrupted result and a run parked on a question nobody will answer. The command's own
// `.describe()` already promised "interactive prompt (CLI) / false (agent, no TTY)", so
// this was documented behaviour that had never been implemented.
//
// CALL-SITE, NOT PREDICATE — `resolveOptionalPrompt` is deliberately NOT exported and is
// deliberately NOT mocked here. A predicate test proves the predicate works and says
// nothing about whether the two call sites reach for it; reverting either site alone
// would leave such a test green. So these drive `worktreesAdd` itself and measure the
// bytes.
//
// `@inquirer/confirm` and `withEscape` are likewise NOT mocked: they are the things that
// produce the bytes under measurement. Only surrounding I/O is stubbed.
//
// The third test is the counterweight, and it is load-bearing. `program.ts` maps the
// CLI's `--yes` onto `confirmedCommand`, so a guard keyed on `confirmedCommand` rather
// than `isAgentMode()` would silently stop `worktrees add --yes` prompting on a terminal —
// fixing the agent direction by breaking the CLI one.

/** Every command line the `$` mock answered — the git tripwire for the order tests. */
const shellCommands = vi.hoisted(() => {
  return [] as string[]
})

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()

  return {
    ...actual,
    $: zxCommandMock((command) => {
      shellCommands.push(command)

      return { stdout: '' }
    }),
  }
})

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/git-utils', () => {
  return { getCurrentWorktrees: vi.fn(), getMainRepoRoot: vi.fn(), getProjectRoot: vi.fn() }
})

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn(), resolveConfiguredIdes: vi.fn(), resolveOrcaLayout: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

// `IDE_MODES` is read at module scope (the zod enum), so the real module has to survive.
vi.mock('src/integrations/ide', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/ide')>()

  return { ...actual, addIdeWorktreeFolders: vi.fn() }
})

// The Orca driver is mocked whole (no `importOriginal`: the real barrel pulls `zx` in before the
// `$` mock's helper import is initialised). When `orca` resolves false NOTHING here may be called,
// and the order test below asserts exactly that — a real `orca status` spawn would be the regression.
vi.mock('src/integrations/orca', () => {
  return {
    OrcaError: class OrcaError extends Error {},
    probeOrca: vi.fn(),
    findOrcaRepo: vi.fn(),
    addOrcaRepo: vi.fn(),
    openOrcaWorktreeTerminals: vi.fn(),
    isOrcaWorktreeListed: vi.fn(),
    createOrcaOpenPoll: vi.fn(),
    buildOrcaTerminalTitle: vi.fn().mockReturnValue('title'),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
const realStdoutWrite = Object.getOwnPropertyDescriptor(process.stdout, 'write')

/** Everything the prompts would have written to the JSON-RPC transport. */
let stdoutBytes: string[] = []

/**
 * A PassThrough standing in for `process.stdin`, matching the shape
 * `src/lib/prompts/__tests__/escapable-context.test.ts` uses: `withEscape` owns the stdin
 * ref, and a bare PassThrough carries neither `ref` nor `unref`, so a fake without them
 * throws rather than merely diverging from reality.
 */
const setStdin = (stream: PassThrough, isTTY: boolean) => {
  Object.defineProperty(stream, 'isTTY', { value: isTTY, configurable: true })
  Object.defineProperty(stream, 'ref', { value: vi.fn(), configurable: true })
  Object.defineProperty(stream, 'unref', { value: vi.fn(), configurable: true })
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
}

/**
 * `@inquirer/core`'s `create-prompt.js` renders to `context.output ?? process.stdout`,
 * and no call site in `worktrees-add` passes `output` — so `process.stdout` is exactly
 * the stream to measure.
 */
const captureStdout = () => {
  stdoutBytes = []
  Object.defineProperty(process.stdout, 'write', {
    value: (chunk: string | Uint8Array) => {
      stdoutBytes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))

      return true
    },
    configurable: true,
    writable: true,
  })
}

/**
 * An unanswered prompt leaves the command PENDING FOREVER, so a regression would surface
 * as a hung suite rather than a failing assertion. Every await below is bounded.
 */
const within = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined

  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms waiting for ${what} — a prompt is probably open and unanswered`))
    }, ms)
  })

  try {
    return await Promise.race([promise, bound])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Answers whatever prompt may have opened, twice, so a REGRESSION fails on the stdout
 * assertion (which names the leaked bytes) instead of dying on the timeout above. On the
 * fixed code no prompt opens and these writes are inert buffered bytes nobody reads.
 */
const rescue = (stdin: PassThrough) => {
  const timers = [300, 700].map((ms) => {
    return setTimeout(() => {
      stdin.write(Buffer.from('\r'))
    }, ms)
  })

  return () => {
    for (const timer of timers) clearTimeout(timer)
  }
}

const addedOptions = () => {
  return vi.mocked(commandEcho.addOption).mock.calls
}

beforeEach(() => {
  vi.clearAllMocks()
  shellCommands.length = 0
  commandEcho.reset()
  vi.spyOn(commandEcho, 'addOption')
  vi.spyOn(commandEcho, 'setInteractive')
  vi.spyOn(commandEcho, 'print').mockImplementation(() => {})

  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(getCurrentWorktrees).mockResolvedValue([])
  vi.mocked(getProjectRoot).mockResolvedValue('/workspace/project-root')
  vi.mocked(getMainRepoRoot).mockResolvedValue('/workspace/project-root')
  vi.mocked(getReleasePRsWithInfo).mockResolvedValue([])
  // The defect precondition: a config that sets NEITHER key. `worktrees` is absent
  // entirely, which is the shape of a repo that has never opted in either way.
  vi.mocked(getInfraKitConfig).mockResolvedValue({
    envManagement: { provider: 'doppler', config: { name: 'test' } },
  })
  vi.mocked(resolveConfiguredIdes).mockReturnValue([])
  vi.mocked(resolveOrcaLayout).mockReturnValue('two-columns')
  vi.mocked(probeOrca).mockResolvedValue('ready')
  vi.mocked(findOrcaRepo).mockResolvedValue({ registered: true, visibility: 'show' })

  captureStdout()
})

afterEach(() => {
  if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
  if (realStdoutWrite) Object.defineProperty(process.stdout, 'write', realStdoutWrite)
  agentMode.source = null
  vi.restoreAllMocks()
})

describe('worktrees-add — the optional follow-up prompts under --agent', () => {
  it('writes ZERO bytes to stdout under --agent and resolves both follow-ups to false', async () => {
    const stdin = new PassThrough()

    // An agent's Bash tool can hand the CLI a TTY stdin (a pty-backed shell), so setting
    // isTTY here means an isTTY-keyed guard would NOT fire — the guard has to key on
    // `isAgentMode()`.
    setStdin(stdin, true)
    agentMode.source = 'flag'

    const cancelRescue = rescue(stdin)

    try {
      await within(
        worktreesAdd({ confirmedCommand: true, versions: '1.2.5' }),
        3000,
        'worktreesAdd to complete without prompting',
      )
    } finally {
      cancelRescue()
    }

    // Not "valid JSON" — EMPTY. The command's own output travels as its return value that
    // `entry/cli.ts` prints under `--json`; anything on stdout here is prompt rendering.
    expect(stdoutBytes.join('')).toBe('')

    expect(addedOptions()).toContainEqual(['--no-github-desktop', true])
    expect(addedOptions()).toContainEqual(['--no-orca', true])
    expect(probeOrca).not.toHaveBeenCalled()
  })

  it('records the resolved values, not merely the absence of a crash', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)
    agentMode.source = 'flag'

    const cancelRescue = rescue(stdin)

    try {
      await within(worktreesAdd({ confirmedCommand: true, all: true, versions: '1.2.5' }), 3000, 'worktreesAdd')
    } finally {
      cancelRescue()
    }

    // The affirmative flags are what a fallen-through prompt answering "yes" (confirm's
    // default) would have recorded, so their absence is the second half of the claim.
    expect(addedOptions()).not.toContainEqual(['--github-desktop', true])
    expect(addedOptions()).not.toContainEqual(['--orca', true])
  })
})

describe('worktrees-add — the confirm site propagates its refusal, in the pinned order', () => {
  // The site sits inside this handler's rewrapping `catch`; a `StructuredRefusalError` is an
  // `OperationError` and must come out intact, `confirmation_required` and all.
  //
  // ORDER, pinned deliberately (docs/orca-migration-plan.md §2.4): the follow-ups resolve BEFORE the
  // confirm (headless → false), then — only when Orca resolves true — `probeOrca` and `findOrcaRepo`,
  // then `confirmation_required`, then git. The preview has to be able to name `orca repo add`, and an
  // explicit `--orca` that cannot be honoured must refuse before the preview.
  it('an unconfirmed agent run throws confirmation_required un-rewrapped, AFTER the follow-ups resolved false and with NO orca spawn', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)
    agentMode.source = 'flag'

    const error = await worktreesAdd({ confirmedCommand: false, versions: '1.2.5' }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'confirmation_required',
      agentMode: 'flag',
    })
    expect((error as StructuredRefusalError).exitCode).toBe(2)
    expect(stdoutBytes.join('')).toBe('')
    expect(addedOptions()).not.toContainEqual(['--yes', true])

    // The follow-ups ran first and resolved headless-false…
    expect(addedOptions()).toContainEqual(['--no-github-desktop', true])
    expect(addedOptions()).toContainEqual(['--no-orca', true])
    // …so the Orca leg was never entered: no `orca` process, not even the readiness probe.
    expect(probeOrca).not.toHaveBeenCalled()
    expect(findOrcaRepo).not.toHaveBeenCalled()
    // And git never ran (the `$` mock records nothing for `git worktree add`).
    expect(shellCommands).not.toContainEqual(expect.stringContaining('git worktree add'))
  })

  it('an unconfirmed agent run with orca=true probes and looks the repo up BEFORE confirmation_required', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)
    agentMode.source = 'flag'
    vi.mocked(findOrcaRepo).mockResolvedValue({ registered: false })

    const error = await worktreesAdd({ confirmedCommand: false, versions: '1.2.5', orca: true }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({ status: 'confirmation_required' })
    expect(probeOrca).toHaveBeenCalledTimes(1)
    expect(findOrcaRepo).toHaveBeenCalledWith('/workspace/project-root')
    // The preview the agent is refused with names the registration it would perform.
    expect((error as StructuredRefusalError).structuredContent.message).toContain(
      'will register project-root in Orca (orca repo add)',
    )
    expect(shellCommands).not.toContainEqual(expect.stringContaining('git worktree add'))
  })

  it('an explicit --orca against an Orca that is not running refuses orca_unreachable BEFORE the confirm and before git', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)
    agentMode.source = 'flag'
    vi.mocked(probeOrca).mockResolvedValue('unreachable')

    const error = await worktreesAdd({ confirmedCommand: false, versions: '1.2.5', orca: true }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'refused',
      reason: 'orca_unreachable',
      agentMode: 'flag',
    })
    expect((error as StructuredRefusalError).exitCode).toBe(2)
    expect(findOrcaRepo).not.toHaveBeenCalled()
    expect(shellCommands).not.toContainEqual(expect.stringContaining('git worktree add'))
  })
})

describe('worktrees-add — the CLI direction still prompts', () => {
  it('reaches the prompt on a TTY even when confirmedCommand is true (the CLI --yes)', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)
    agentMode.source = null

    // Esc, one raw 0x1b byte — the same cancellation path `withEscape` binds in
    // production. It only lands if a real prompt is open, so the rejection below is
    // itself evidence that the ask callback ran.
    const escape = setTimeout(() => {
      stdin.write(Buffer.from([0x1b]))
    }, 300)
    // Backstop: if Esc were dead, answer the prompt instead of hanging the suite.
    const cancelRescue = rescue(stdin)

    try {
      await within(
        // Settled either way: Esc rejects with `AbortPromptError`, the backstop resolves it.
        // Neither outcome is the claim — the bytes are.
        worktreesAdd({ confirmedCommand: true, versions: '1.2.5' }).then(
          () => {
            return 'resolved'
          },
          () => {
            return 'rejected'
          },
        ),
        3000,
        'the GitHub Desktop prompt to open and take an Esc',
      )
    } finally {
      clearTimeout(escape)
      cancelRescue()
    }

    // A guard keyed on `confirmedCommand` would leave this empty: `--yes` is set.
    expect(stdoutBytes.join('')).toContain('Open created worktrees in GitHub Desktop?')
  })
})
