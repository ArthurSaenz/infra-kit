import { beforeEach, describe, expect, it, vi } from 'vitest'

import { probeEnvToken } from '../doppler-project'

/**
 * zx is mocked as the DEFAULT `$` import — a named import is un-spyable, and every call the probe makes
 * goes through `$({ env })\`…\`.timeout(ms)`, so the mock has to model all three links of that chain.
 */
const zx = vi.hoisted(() => {
  return {
    stdout: 'dev\n',
    error: null as unknown,
    calls: [] as Array<{ env: NodeJS.ProcessEnv | undefined; args: unknown[] }>,
  }
})

vi.mock('zx', () => {
  const $ = Object.assign(
    vi.fn((options: { env?: NodeJS.ProcessEnv }) => {
      return (_strings: TemplateStringsArray, ...args: unknown[]) => {
        zx.calls.push({ env: options.env, args })

        return {
          timeout: () => {
            return zx.error ? Promise.reject(zx.error) : Promise.resolve({ stdout: zx.stdout })
          },
        }
      }
    }),
    { quiet: false },
  )

  return { $ }
})

const TOKEN = 'dp.st.dev.SUPER-SECRET-DO-NOT-PRINT'

const probe = async () => {
  return probeEnvToken({
    childEnv: { PATH: '/bin', DOPPLER_TOKEN: TOKEN },
    project: 'api',
    config: 'dev',
  })
}

/** zx's `ProcessOutput`, duck-typed: the probe reads the failure off `.stderr`. */
const processOutput = (stderr: string): unknown => {
  return { stderr, message: stderr }
}

describe('probeEnvToken — validity and scope in one round trip', () => {
  beforeEach(() => {
    zx.stdout = 'dev\n'
    zx.error = null
    zx.calls = []
  })

  it('is valid when the config read back equals the config we asked for', async () => {
    expect(await probe()).toEqual({ outcome: 'valid', scopedTo: 'dev' })
  })

  /** Belt and braces: the CLI enforces scope on the wire, so this branch means Doppler let one through. */
  it('is mis-scoped when Doppler returns a DIFFERENT config on a successful read', async () => {
    zx.stdout = 'prod\n'

    expect(await probe()).toEqual({ outcome: 'mis-scoped', scopedTo: 'prod' })
  })

  it('is revoked on "Invalid Auth token"', async () => {
    zx.error = processOutput('Doppler Error: Invalid Auth token')

    expect(await probe()).toEqual({ outcome: 'revoked' })
  })

  it("is mis-scoped on the CLI's own scope refusal", async () => {
    zx.error = processOutput("Doppler Error: This token does not have access to requested config 'prod'")

    expect(await probe()).toEqual({ outcome: 'mis-scoped' })
  })

  /** A dead network says NOTHING about a token. Guessing here is how doctor would start lying. */
  it('is unreachable — not revoked — on a network failure', async () => {
    zx.error = new Error('connect ETIMEDOUT')

    expect(await probe()).toEqual({ outcome: 'unreachable' })
  })

  /** A wrong PROJECT name is a config bug, not a token verdict. */
  it('is unreachable on a project not-found', async () => {
    zx.error = processOutput("Doppler Error: Could not find requested project 'api'")

    expect(await probe()).toEqual({ outcome: 'unreachable' })
  })

  it('passes the token by ENV and never by argv — `ps` shows argv to every user on the box', async () => {
    await probe()

    const call = zx.calls[0]!

    expect(call.env?.DOPPLER_TOKEN).toBe(TOKEN)
    expect(call.args).toEqual(['DOPPLER_CONFIG', 'api', 'dev'])
    expect(JSON.stringify(call.args)).not.toContain(TOKEN)
  })
})
