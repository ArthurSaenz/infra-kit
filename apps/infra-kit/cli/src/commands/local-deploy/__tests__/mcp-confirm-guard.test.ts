import { Buffer } from 'node:buffer'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mcpMode } from 'src/lib/mcp-mode'

import type { DeployService } from '../service-discovery'

/**
 * G0f — the MCP confirm guard, measured in BYTES ON `process.stdout`.
 *
 * `tool-handler.ts:466` calls `handler({ ...params, confirmedCommand: true })` for every MCP tool
 * call it lets through, and injects nothing else. When `LocalDeployArgs` spelled the field `yes`,
 * an MCP call left it `undefined`, `!yes` was true, and `confirmTarget` rendered a real
 * `@inquirer/confirm` — which `create-prompt.js` pipes to `context.output ?? process.stdout`, and
 * no call site here passes `output`. Under MCP stdio `process.stdout` IS the JSON-RPC transport, so
 * the failure is stream corruption, not a hang.
 */

// A CALL-SITE test on purpose. An earlier revision of this plan asserted an extracted
// `shouldSkipConfirm` predicate; that proves the predicate works and says nothing about whether the
// guard calls it, so all three reverts of the fix stayed green. Nothing below may mock `@inquirer/*`
// or `withEscape` — those are precisely the things whose bytes are being measured. Only the I/O
// around them is faked: git, AWS/gh (via `zx`), config, discovery, spawn, logger, commandEcho.

/** The AWS account `runPreflight` must see, and the env it must agree with. */
const ACCOUNT_ID = '123456789012'

/**
 * A PERSONAL env, so `isSharedEnv` is false and the guard reaches `@inquirer/confirm` rather than
 * `@inquirer/select`. Either prompt corrupts the transport; confirm is the cheaper of the two.
 */
const PERSONAL_ENV = 'arthur'

const SERVICE: DeployService = {
  name: 'client-be',
  scriptPath: '/fake-repo/devops/scripts/deploy-client-be.sh',
  allowedEnvs: null,
  ssmPrefix: 'fake',
}

/** A `zx` result: awaitable for `` $`x` `` and `.quiet()`-able for `` $`x`.quiet() ``. */
const zxResult = (stdout: string) => {
  const promise = Promise.resolve({ stdout, stderr: '', exitCode: 0 })

  return Object.assign(promise, {
    quiet: () => {
      return promise
    },
  })
}

vi.mock('zx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zx')>()

  const run = (strings: TemplateStringsArray, values: unknown[]) => {
    const command = strings.reduce((acc, part, index) => {
      return acc + part + (index < values.length ? String(values[index]) : '')
    }, '')

    // `gh run list` seeds the in-flight-CI guard; the two `aws` calls are the account lookup that
    // `runPreflight` gates on. The account must REPORT the env we asked for, or
    // `assertEnvMatchesAccount` throws long before the confirm guard is reached.
    if (command.includes('gh run list')) return zxResult('[]')
    if (command.includes('get-caller-identity')) return zxResult(ACCOUNT_ID)
    if (command.includes('ssm get-parameter')) return zxResult(PERSONAL_ENV)

    return zxResult('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  }

  const $ = Object.assign(
    (first: TemplateStringsArray, ...values: unknown[]) => {
      return run(first, values)
    },
    { quiet: false },
  )

  return { ...actual, $ }
})

vi.mock('src/lib/git-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/git-utils')>()

  return {
    ...actual,
    getProjectRoot: () => {
      return Promise.resolve('/fake-repo')
    },
    getCurrentBranch: () => {
      return Promise.resolve('main')
    },
    isWorkingTreeClean: () => {
      return Promise.resolve(true)
    },
  }
})

vi.mock('src/lib/workflow-envs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/workflow-envs')>()

  // The real `isProtectedEnv` / `assertDeployable` / `deployableEnvs` stay in play — only the two
  // functions that touch disk (the workflow YAML and the project config) are replaced.
  return {
    ...actual,
    readWorkflowEnvOptions: () => {
      return Promise.resolve(['dev', PERSONAL_ENV])
    },
    resolveProtectedEnvAccess: () => {
      return Promise.resolve({ allowed: false, reason: 'disallow' as const })
    },
  }
})

vi.mock('../service-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../service-discovery')>()

  // `eligibleServices` and `isEligible` stay real — the run must genuinely pass them.
  return {
    ...actual,
    discoverServices: () => {
      return Promise.resolve([SERVICE])
    },
  }
})

vi.mock('node:child_process', () => {
  // Reached only when the guard is correctly SKIPPED, i.e. on the passing path. Without it the fixed
  // code would `spawn('/bin/sh', ['/fake-repo/…'])` for real.
  return {
    spawn: () => {
      return {
        on: (event: string, handler: (code?: number) => void) => {
          if (event === 'close')
            setImmediate(() => {
              return handler(0)
            })
        },
      }
    },
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

vi.mock('src/lib/command-echo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/command-echo')>()

  return {
    ...actual,
    commandEcho: { setInteractive: vi.fn(), addOption: vi.fn(), print: vi.fn() },
  }
})

const { localDeployAll } = await import('../local-deploy')

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
const realWrite = process.stdout.write.bind(process.stdout)

/**
 * The `stdio: 'inherit'` shape from `commands/mcp/mcp.ts`: a terminal-launched `infra-kit mcp` has a
 * real TTY stdin carrying JSON-RPC. `isTTY: true` is therefore the honest fixture, and it is also
 * what lets `@inquirer` arm readline at all — a prompt that could not render would make this vacuous.
 */
const installStdin = () => {
  const stream = new PassThrough()

  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(stream, 'ref', { value: vi.fn(), configurable: true })
  Object.defineProperty(stream, 'unref', { value: vi.fn(), configurable: true })
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true })

  return stream
}

afterEach(() => {
  if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
  process.stdout.write = realWrite
  mcpMode.enabled = false
  vi.restoreAllMocks()
})

type Outcome = 'resolved' | 'rejected' | 'pending'

/**
 * Bounded await that reports a STATUS instead of rejecting.
 *
 * The regression leaves a prompt open forever, so an unbounded await would surface as a HUNG SUITE
 * rather than a failure — hence the bound. It resolves rather than rejects because the byte
 * assertion is the verdict and must run FIRST: a helper that threw on the timeout would abort the
 * test before it could report the corruption it exists to catch. `.then(ok, err)` is attached here
 * so a late rejection never escapes as an unhandled one.
 */
const settled = async (promise: Promise<unknown>, ms: number): Promise<Outcome> => {
  const pendingMarker = Symbol('pending')
  let timer: NodeJS.Timeout | undefined

  const bound = new Promise<symbol>((resolve) => {
    timer = setTimeout(() => {
      resolve(pendingMarker)
    }, ms)
  })

  const watched = promise.then(
    (): Outcome => {
      return 'resolved'
    },
    (): Outcome => {
      return 'rejected'
    },
  )

  try {
    const winner = await Promise.race([watched, bound])

    return winner === pendingMarker ? 'pending' : (winner as Outcome)
  } finally {
    clearTimeout(timer)
  }
}

describe('local deploy under MCP — the confirm guard (G0f)', () => {
  it('writes ZERO bytes to process.stdout when the chokepoint injects confirmedCommand', async () => {
    const stdin = installStdin()

    mcpMode.enabled = true

    const captured: string[] = []

    // `create-prompt.js` does `output.pipe(context.output ?? process.stdout)`, so every prompt byte
    // arrives through this exact method. Swapping the method (rather than the stream) keeps the pipe
    // target identical to production while making the bytes countable.
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))

      return true
    }) as typeof process.stdout.write

    // Exactly the call the MCP chokepoint makes: the tool's own params, plus `confirmedCommand`.
    const pending = localDeployAll({ env: PERSONAL_ENV, confirmedCommand: true })

    const outcome = await settled(pending, 3000)
    const written = captured.join('')

    // Snapshotted BEFORE the rescue below, so the rescue's own teardown bytes cannot pollute it.
    if (outcome === 'pending') {
      // A live prompt holds readline on the fake stdin; answering it lets the run finish and the
      // suite exit instead of leaking a handle. Failure here is irrelevant — the verdict is above.
      stdin.write(Buffer.from('\n'))
      await settled(pending, 3000)
    }

    // WHICH LEG FIRES, and why it changed. When this was written, reverting the field name let
    // `confirmTarget` render a real `@inquirer/confirm` and the byte assertion below caught it with 61
    // captured bytes. PR-0b then gave that site `whenHeadless: 'refuse'`, so the same revert now
    // throws inside `withEscape` BEFORE inquirer renders: stdout stays empty and the `outcome` leg is
    // what reddens. Both legs are kept deliberately. The byte leg is no longer the one that fires on
    // the field regression, but it is the only thing here that would catch a future site whose policy
    // answered instead of refusing — and it costs nothing to keep. Do not delete it as "always green":
    // it is green because a SECOND guard now stands in front of it, not because it never mattered.
    //
    // The dangerous combination — this site's policy becoming `{ value: … }` while the field also
    // regresses, which would deploy unconfirmed with every leg here green — is caught elsewhere, by
    // the policy-table row in `lib/prompts/__tests__/headless-policy-guards.test.ts` ("declares every
    // reachable site that answers with anything but refuse"). Verified: flipping this site to
    // `{ value: true }` reddens that row.
    expect(written, `prompt bytes leaked into the MCP stdio transport: ${JSON.stringify(written)}`).toBe('')

    expect(outcome, 'the run never finished — confirmTarget opened a prompt nobody can answer over JSON-RPC').toBe(
      'resolved',
    )

    await expect(pending).resolves.toMatchObject({ structuredContent: { environment: PERSONAL_ENV, success: true } })
  })
})
