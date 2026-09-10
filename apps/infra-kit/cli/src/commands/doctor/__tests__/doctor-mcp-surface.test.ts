import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { doctor, doctorMcpTool } from '../doctor'

/**
 * @fileoverview
 * U-D2 / U-D5 — the catalog says `doctor` is `mutating: false` while `doctor --fix` chmods the token
 * store and prunes portless routes. That claim is about the EXPOSED TOOL, and this file is what makes
 * it a measurement rather than a promise.
 *
 * It has been specified wrongly four times, with five distinct failure modes, every one of which
 * produced a GREEN suite over a live hole:
 *
 * | Attempt | Seam                                              | Why it did not bite                                  |
 * | ------- | ------------------------------------------------- | ---------------------------------------------------- |
 * | 1       | `vi.spyOn(doctorModule, 'checkTokenStorePerms')`  | ESM same-module self-call binds the module-local const |
 * | 2       | `vi.mock('src/lib/env-tokens')`, assert no writes | Wrong module — it exports no chmod at all             |
 * | 3       | `vi.spyOn(fs, 'chmodSync')`, bare negative        | Right seam, but green on any machine with no store    |
 * | 4       | positive control FIRST, then the negative         | The positive half chmods the fixture tight; the negative half then returns early and passes under the mutation |
 *
 * Read the two comments marked LOAD-BEARING before editing anything here.
 */

/** Set by `beforeEach`; read at CALL time by the mock factory below, never at hoist time. */
let storeRoot: string | null = null

/** `<tmp>/.infra-kit/projects/api/tokens.json` — the exact shape `checkTokenStorePerms` walks. */
const tokenTarget = (): string => {
  if (storeRoot === null) throw new Error('the token-store fixture was read before beforeEach built it')

  return path.join(storeRoot, '.infra-kit', 'projects', 'api', 'tokens.json')
}

/**
 * The four paths the check audits, derived the same way the check derives them (`path.dirname` three
 * times). Assertions match on THESE rather than on a bare call count, so an unrelated `chmodSync`
 * somewhere else in `doctor()` cannot make either half of the test lie.
 */
const auditedPaths = (): string[] => {
  const target = tokenTarget()
  const projectDir = path.dirname(target)
  const projectsDir = path.dirname(projectDir)
  const userConfigDir = path.dirname(projectsDir)

  return [userConfigDir, projectsDir, projectDir, target]
}

/**
 * The factory must supply `readTokenStore` as well as `getTokenStorePath`: `doctor.ts` imports both,
 * and `readTokenStore` backs `deps.readStore` in two checks that run in the same `doctor()` pass. A
 * factory carrying only the path throws rather than silently mis-measuring — named here so nobody
 * burns a cycle rediscovering it.
 */
vi.mock('src/lib/env-tokens', () => {
  return {
    getTokenStorePath: vi.fn(() => {
      return Promise.resolve(tokenTarget())
    }),
    readTokenStore: vi.fn(() => {
      return Promise.resolve({ version: 1, envs: {} })
    }),
  }
})

/**
 * LOAD-BEARING (safety, not speed): `listRoutes: () => []` is what stops this file deleting the
 * developer's real portless routes.
 */
// `doctor({ fix: true })` runs `pruneStalePortlessRoutes()`, and `decidePrune` returns EVERY non-live
// route as prunable whenever no `infra-kit dev` runner is alive — the ordinary state of a machine
// running a unit suite. Neither assertion below would notice the deletion: both match on fixture paths.
// The damage surfaces later as a 502'ing dev proxy, which this repo has a recorded case of from an
// unrelated cause, so the likely outcome is a misdiagnosis rather than a trace back to a test run.
//
// Two traps, both of which have bitten this repo:
//  1. `pruneStalePortlessRoutes` is defined IN `doctor.ts` and called from `doctor.ts` — mocking
//     `src/commands/doctor/prune-routes` does not intercept it. The interceptable seam is this
//     cross-module named import.
//  2. The mock must be PARTIAL, via `importOriginal`: `doctor.ts` consumes nine named exports from
//     this module, and a wholesale replacement breaks the import graph before a single check runs —
//     failing at import time in a way that looks nothing like a fixture problem.
//
// The overrides past `listRoutes` are ordinary speed/determinism stubs: they are all READERS (TCP
// probes and a TLS handshake against :443), and the chmod seam is independent of them.
vi.mock('src/dev/proxy/portless-driver', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('src/dev/proxy/portless-driver')>()),
    listRoutes: () => {
      return []
    },
    resolvePortlessBin: () => {
      return '/nowhere/portless'
    },
    readCaPath: () => {
      return '/nowhere/ca.pem'
    },
    caFingerprintMatches: () => {
      return true
    },
    defaultIsListening: () => {
      return Promise.resolve(true)
    },
    defaultIsProxyServing: () => {
      return Promise.resolve(true)
    },
    handshakeChainsToCa: () => {
      return Promise.resolve({ ok: true })
    },
  }
})

// Partial for the same import-graph reason: `env-load` (imported for `buildDopplerChildEnv`) pulls its
// own constants off this barrel. Both overrides are network readers.
vi.mock('src/integrations/doppler', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('src/integrations/doppler')>()),
    resolveEnvToken: vi.fn(() => {
      return Promise.resolve({ token: 'redacted', source: 'store' })
    }),
    probeEnvToken: vi.fn(() => {
      return Promise.resolve({ outcome: 'unreachable' })
    }),
  }
})

// Every `--version` probe and every `gh auth status` spawn. Readers, stubbed for speed and to keep the
// suite off the network.
vi.mock('zx', () => {
  return {
    $: vi.fn(() => {
      return Promise.resolve({ stdout: '', stderr: '' })
    }),
  }
})

const chmodSpy = vi.spyOn(fs, 'chmodSync')

beforeEach(() => {
  storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-token-store-'))

  const target = tokenTarget()

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify({ version: 1, envs: {} }))

  // Modes set EXPLICITLY after creation, never inherited from the creating call, whose result umask
  // perturbs. All four must end up loose, so that `loose.length === 4` and the check reaches its chmod
  // loop instead of returning early on "no store" or "perms already correct".
  for (const audited of auditedPaths()) {
    // Deliberately insecure: loose modes ARE the state under test.
    fs.chmodSync(audited, audited === target ? 0o644 : 0o755)
  }

  chmodSpy.mockClear()
})

afterEach(() => {
  if (storeRoot !== null) fs.rmSync(storeRoot, { recursive: true, force: true })
  storeRoot = null
})

/** Every path this spy was called with, in call order. */
const chmoddedPaths = (): unknown[] => {
  return chmodSpy.mock.calls.map((call) => {
    return call[0]
  })
}

describe('the exposed doctor tool cannot reach --fix', () => {
  /**
   * U-D2(a). Cheap and bypassable on its own — `(params = {}) => …` and `(...args) => …` both report
   * length 0 — which is exactly why (b) exists and never inspects the signature.
   */
  it('declares a parameterless handler', () => {
    expect(doctorMcpTool.handler).toHaveLength(0)
  })

  /**
   * U-D2(b). One fixture, two assertions in OPPOSITE directions, in this order.
   *
   * LOAD-BEARING: the negative assertion runs FIRST, and `chmodSpy` is NOT cleared between the two.
   * `vi.spyOn` calls through and nothing in this repo's vitest config auto-clears, so a positive-first
   * ordering would physically chmod the fixture tight — and the handler would then find
   * `loose.length === 0`, return early, and record zero calls even under the mutation. The repair a
   * maintainer reaches for at that point is `chmodSpy.mockClear()` between the assertions, and THAT
   * single line is what converts "red on correct code" into "green on the mutation". Do not reorder
   * these two assertions, and do not clear between them.
   *
   * Correct code gives 0 then 4. The mutation — `handler: (params) => doctor(params)` — gives 4 then
   * 4, and reds on the FIRST assertion, before the fixture has been altered.
   */
  it('chmods nothing through the MCP handler, on a fixture the CLI path demonstrably chmods', async () => {
    // 1. The invariant. `fix` and `confirmedCommand` are what an agent could plausibly send; the empty
    //    `inputSchema` means neither is declared, so neither may reach the check.
    await doctorMcpTool.handler({ fix: true, confirmedCommand: true } as never)

    for (const audited of auditedPaths()) {
      expect(chmoddedPaths(), `the MCP handler chmodded ${audited}`).not.toContain(audited)
    }

    // 2. The positive control, on the SAME still-loose fixture. Without this half, assertion 1 asserts
    //    nothing: `checkTokenStorePerms` reaches zero chmods down three other paths that are the
    //    ordinary state of a developer machine and of CI.
    await doctor({ fix: true })

    for (const audited of auditedPaths()) {
      expect(chmoddedPaths(), `the CLI --fix path never reached ${audited}`).toContain(audited)
    }
  })
})

/**
 * U-D5 — the seam guard for the test above.
 *
 * `vi.spyOn(fs, 'chmodSync')` intercepts `doctor.ts`'s writes ONLY because line 1 is a DEFAULT import.
 * Rewrite it to `import { chmodSync } from 'node:fs'` and the spy observes zero calls while the real
 * chmod still happens — U-D2(b)'s negative half passes for the wrong reason, its positive half fails,
 * and the obvious "fix" is to weaken the positive half. This repo's post-edit formatter rewrites
 * imports, so the risk is live rather than theoretical.
 */
describe('doctor.ts keeps the import style U-D2(b) depends on', () => {
  it('imports node:fs as a default import', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'doctor.ts'), 'utf-8')

    expect(
      source,
      "doctor.ts must keep `import fs from 'node:fs'`. A NAMED import of chmodSync silently defeats " +
        "vi.spyOn(fs, 'chmodSync'), which is the only seam proving the MCP handler cannot reach --fix.",
    ).toContain("import fs from 'node:fs'")
  })
})
