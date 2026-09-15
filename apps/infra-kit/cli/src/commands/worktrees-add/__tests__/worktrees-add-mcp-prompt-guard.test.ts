import { Buffer } from 'node:buffer'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getReleasePRsWithInfo } from 'src/integrations/gh'
import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { getCurrentWorktrees, getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { zxCommandMock } from 'src/lib/git-utils/__tests__/zx-command-mock'
import { getInfraKitConfig, resolveConfiguredIdes } from 'src/lib/infra-kit-config'

import { worktreesAdd } from '../worktrees-add'

/**
 * G0g — the two "open it in X?" follow-ups in `worktrees-add`, driven through the REAL
 * exported command.
 *
 * @example
 * // MCP, no flags, no config keys => both resolve false, stdout stays byte-for-byte empty
 * await worktreesAdd({ confirmedCommand: true, versions: '1.2.5' })
 */

// WHAT THIS GUARDS — `worktrees-add` is an exposed MCP tool and is UNGATED
// (`requiresHumanConfirm` is unset), so a single call carrying `versions` or `all` runs
// end to end. With neither the flag nor the config key set, both follow-ups used to fall
// through to `withEscape(confirm(…))`, and `@inquirer` renders to `process.stdout` —
// which under MCP stdio IS the JSON-RPC transport. Two prompts, a corrupted stream. The
// tool's own `.describe()` already promised "interactive prompt (CLI) / false (MCP, no
// TTY)", so this was documented behaviour that had never been implemented.
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
// fixing the MCP direction by breaking the CLI one.

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()

  return {
    ...actual,
    $: zxCommandMock(() => {
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
  return { getInfraKitConfig: vi.fn(), resolveConfiguredIdes: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return { getReleasePRsWithInfo: vi.fn() }
})

// `IDE_MODES` is read at module scope (the zod enum), so the real module has to survive.
vi.mock('src/integrations/ide', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/ide')>()

  return { ...actual, addIdeWorktreeFolders: vi.fn() }
})

vi.mock('src/integrations/cmux', () => {
  return {
    buildCmuxWorkspaceTitle: vi.fn().mockReturnValue('title'),
    createCmuxGroupFrom: vi.fn(),
    findCmuxGroupRefByName: vi.fn(),
    listCmuxWorkspacesByCwd: vi.fn().mockResolvedValue(new Set<string>()),
    openCmuxWorkspaceWithLayout: vi.fn(),
    realpathForCmuxCwd: vi.fn(async (cwd: string) => {
      return cwd
    }),
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

  captureStdout()
})

afterEach(() => {
  if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
  if (realStdoutWrite) Object.defineProperty(process.stdout, 'write', realStdoutWrite)
  agentMode.source = null
  vi.restoreAllMocks()
})

describe('worktrees-add — the optional follow-up prompts under MCP', () => {
  it('writes ZERO bytes to the JSON-RPC transport and resolves both follow-ups to false', async () => {
    const stdin = new PassThrough()

    // `stdio: 'inherit'` is how `commands/mcp/mcp.ts` spawns the server, so a
    // terminal-launched `infra-kit mcp` really does have a TTY stdin. Setting isTTY here
    // means an isTTY-keyed guard would NOT fire — the guard has to key on `isAgentMode()`.
    setStdin(stdin, true)
    agentMode.source = 'mcp'

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

    // Not "valid JSON-RPC" — EMPTY. The command's own output travels as the tool's return
    // value; anything on stdout here is prompt rendering, i.e. transport corruption.
    expect(stdoutBytes.join('')).toBe('')

    expect(addedOptions()).toContainEqual(['--no-github-desktop', true])
    expect(addedOptions()).toContainEqual(['--no-cmux', true])
  })

  it('records the resolved values, not merely the absence of a crash', async () => {
    const stdin = new PassThrough()

    setStdin(stdin, true)
    agentMode.source = 'mcp'

    const cancelRescue = rescue(stdin)

    try {
      await within(worktreesAdd({ confirmedCommand: true, all: true, versions: '1.2.5' }), 3000, 'worktreesAdd')
    } finally {
      cancelRescue()
    }

    // The affirmative flags are what a fallen-through prompt answering "yes" (confirm's
    // default) would have recorded, so their absence is the second half of the claim.
    expect(addedOptions()).not.toContainEqual(['--github-desktop', true])
    expect(addedOptions()).not.toContainEqual(['--cmux', true])
  })
})

describe('worktrees-add — the confirm site propagates its refusal', () => {
  // The site sits inside this handler's rewrapping `catch`; a `StructuredRefusalError` is an
  // `OperationError` and must come out intact, `confirmation_required` and all.
  it('an unconfirmed agent run throws confirmation_required un-rewrapped, before the follow-ups', async () => {
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
