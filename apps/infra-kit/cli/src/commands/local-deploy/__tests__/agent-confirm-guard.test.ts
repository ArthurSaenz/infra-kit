import process from 'node:process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { agentMode } from 'src/lib/agent-mode'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'

import type { DeployService } from '../service-discovery'

/**
 * The confirm site of `local deploy` as a Bash-driven agent meets it: a `--agent` run without
 * `--env` is refused with the env form as `choices`, and an unconfirmed `--agent` run with `--env`
 * throws `confirmation_required` after preflight — `confirmTarget` gates through `withEscape`, not
 * `confirmOrExit`, and must speak the same shape.
 */

// A CALL-SITE test on purpose: an extracted predicate proves the predicate works and says nothing
// about whether the guard calls it. Nothing below may mock `@inquirer/*` or `withEscape` — those are
// the things whose refusal is being measured. Only the I/O around them is faked: git, AWS/gh (via
// `zx`), config, discovery, spawn, logger, commandEcho.

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

const { localDeployAll, localDeploySelected, localDeploySelectedMcpTool } = await import('../local-deploy')

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')

/**
 * An agent's Bash tool can hand the CLI a pty-backed stdin, so `isTTY: true` is the honest fixture —
 * and it is also what lets `@inquirer` arm readline at all: a prompt that could not render would
 * make the refusal vacuous.
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
  agentMode.source = null
  vi.restoreAllMocks()
})

describe('local deploy for a Bash-driven agent — argument_required with the env form as choices', () => {
  // Services discovered, workflow envs stubbed: a `--agent` run without `--env` is refused BEFORE
  // the env picker, and `choices` is the command's own env-only form rendered as JSON Schema — the
  // rows a human would have been offered.
  it('omitting --env names `env` and carries the env-only form; nothing is preflighted or deployed', async () => {
    installStdin()
    agentMode.source = 'flag'

    const error = await localDeploySelected({ service: [SERVICE.name], confirmedCommand: true }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)

    const schema = await localDeploySelectedMcpTool.formProvider!.buildRequestedSchema({ service: [SERVICE.name] })

    expect(schema).not.toBeNull()
    expect((error as StructuredRefusalError).structuredContent).toEqual({
      status: 'argument_required',
      argument: 'env',
      choices: z.toJSONSchema(schema!),
      agentMode: 'flag',
    })
    expect((error as StructuredRefusalError).exitCode).toBe(2)
  })
})

describe('local deploy for a Bash-driven agent — the confirm site propagates confirmation_required', () => {
  // The ninth-and-a-half confirm site: `confirmTarget` gates through `withEscape`, not
  // `confirmOrExit`, and must speak the same shape — plan = env, services, the authenticated account.
  it('an unconfirmed --agent run with --env throws confirmation_required after preflight, deploying nothing', async () => {
    installStdin()
    agentMode.source = 'flag'

    const error = await localDeployAll({ env: PERSONAL_ENV, confirmedCommand: false }).catch((e: unknown) => {
      return e
    })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'confirmation_required',
      message: `Deploy 1 service(s) to ${PERSONAL_ENV} from this machine?`,
      plan: { env: PERSONAL_ENV, services: [SERVICE.name], accountId: ACCOUNT_ID, shared: false },
      agentMode: 'flag',
    })
    expect((error as StructuredRefusalError).exitCode).toBe(2)
  })
})
