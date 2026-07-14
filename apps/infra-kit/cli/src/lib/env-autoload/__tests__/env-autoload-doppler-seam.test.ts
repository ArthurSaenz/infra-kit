import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { translateDopplerDownloadError } from 'src/commands/env-load/env-load'
import { isDopplerAuthError, resolveEnvToken } from 'src/integrations/doppler'
import { INFRA_KIT_SESSION_VAR, getSessionCacheDir } from 'src/lib/constants'
import { isEnvAuthFailure } from 'src/lib/errors/env-auth-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig, getInfraKitConfigPaths } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import type { AuthFailureMarker } from '../auth-failure'
import { parseAuthFailureMarker } from '../auth-failure'
import { runEnvAutoLoad } from '../env-autoload'

/**
 * THE SEAM TEST. `env-autoload` does not mock `env-load` here — it drives the REAL
 * `writeEnvLoadFile` against a REAL `doppler secrets download` failure, so the error that
 * reaches `runEnvAutoLoad`'s catch is the one production actually throws.
 *
 * The shipped defect lived exactly in this gap and nowhere else: `env-load` translated
 * Doppler's raw stderr into a friendly message, `env-autoload` then classified that message
 * by grepping for the RAW stderr markers ('Invalid Auth token'), which the translation had
 * already removed. Every unit test on both sides was green — `env-autoload`'s tests handed
 * `runEnvAutoLoad` a hand-rolled `new Error('Doppler Error: Invalid Auth token')`, a shape
 * production never produces. A revoked token therefore wrote only the 30s transient flag,
 * never the sticky marker, and a shell-startup user was warned by nothing, ever.
 *
 * So: assert on the STICKY MARKER and the WARNING, from the raw stderr in, every time.
 */

/** The token literal every leak assertion hunts for. Doppler echoes nothing like it — we inject it. */
const TOKEN = 'dp.st.dev.SEAM_LEAK_CANARY_00000'

/** Verbatim `doppler secrets download` stderr, revoked/garbage token (live CLI v3.76.0, SPIKE-0 Q1). */
const REVOKED_STDERR = ['Unable to download secrets', 'Doppler Error: Invalid Auth token'].join('\n')

/** Verbatim `doppler secrets download` stderr, token scoped to another config (SPIKE-0 Q4). */
const MIS_SCOPED_STDERR = [
  'Unable to download secrets',
  "Doppler Error: This token does not have access to requested config 'dev_personal'",
].join('\n')

const AUTH_FAIL_MARKER_FILE = 'autoload-auth-fail.json'
const FAIL_SENTINEL_FILE = 'autoload-fail.flag'

const { download } = vi.hoisted(() => {
  return { download: { stdout: '{}', error: null as unknown } }
})

// zx is mocked as the DEFAULT `$` export — a named import is bound at import time and un-spyable.
// The download is `$({ env })\`doppler …\`.timeout(ms)`, so the mock is a two-stage call and only
// `.timeout()` is awaited (an eagerly-created rejected promise would surface as unhandled).
vi.mock('zx', () => {
  const tagged = () => {
    return () => {
      return {
        timeout: () => {
          return download.error ? Promise.reject(download.error) : Promise.resolve({ stdout: download.stdout })
        },
      }
    }
  }

  return { $: vi.fn(tagged) }
})

// `getInfraKitConfigPaths` is what `lib/env-tokens` derives the TOKEN STORE path from, so it must be
// mocked too or the store seam below reads the developer's REAL ~/.infra-kit (and the "no token"
// tests would quietly pass or fail on whatever is actually on this machine).
vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn(), getInfraKitConfigPaths: vi.fn() }
})

vi.mock('src/lib/git-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/git-utils')>()

  return { ...actual, getProjectRoot: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { warn: vi.fn(), debug: vi.fn() } }
})

/** A zx `ProcessOutput`-shaped rejection: the raw stderr is on `.stderr`, as the real thing carries it. */
const dopplerFailure = (stderr: string): Error => {
  return Object.assign(new Error(stderr), { stderr, exitCode: 1 })
}

const markerPath = (): string => {
  return path.join(getSessionCacheDir(), AUTH_FAIL_MARKER_FILE)
}

const readMarker = (): AuthFailureMarker | null => {
  return parseAuthFailureMarker(JSON.parse(fs.readFileSync(markerPath(), 'utf-8')))
}

/** Every warning line the run emitted, joined — the surface the user is guaranteed to see. */
const warnings = (): string => {
  return vi
    .mocked(logger.warn)
    .mock.calls.map(([message]) => {
      return String(message)
    })
    .join('\n')
}

const ORIGINAL_ENV = { ...process.env }

let cacheRoot: string
let repoRoot: string
let homeRoot: string

/** The mocked `~/.infra-kit/projects/<repo>/tokens.json` — the REAL `readTokenStore` reads this path. */
const storePath = (): string => {
  return path.join(homeRoot, 'projects', 'seam', 'tokens.json')
}

/**
 * Hand the CI/agent channel a token. Called ONLY by the describes that need to REACH Doppler.
 *
 * It is deliberately NOT in the top-level `beforeEach` any more: a file-wide `INFRA_KIT_ENV_TOKEN`
 * made `resolveEnvToken` ALWAYS succeed, so the only errors that could ever reach `runEnvAutoLoad` in
 * the file written to guard this seam were the ones injected at the zx mock — i.e. Doppler
 * REJECTIONS. The resolver-throws-BEFORE-Doppler path (no token: the migration case) and the
 * store-throws-before-the-resolver path (corrupt store) were never crossed, and both shipped silent.
 */
const withEnvToken = (): void => {
  process.env.INFRA_KIT_ENV_TOKEN = TOKEN
}

beforeEach(() => {
  vi.clearAllMocks()
  download.error = null
  download.stdout = JSON.stringify({ API_URL: 'https://api.example.com', DOPPLER_CONFIG: 'dev' })

  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-seam-cache-'))
  repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-seam-repo-')))
  homeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-seam-home-')))

  // Scrub EVERY INFRA_KIT_* var: a leaked INFRA_KIT_SESSION from the dev's real shell repoints
  // the session cache dir and makes every marker assertion below vacuous — and a leaked
  // INFRA_KIT_ENV_TOKEN would hand the no-token tests a token and make them vacuous too.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INFRA_KIT_')) {
      delete process.env[key]
    }
  }

  process.env.XDG_CACHE_HOME = cacheRoot
  process.env[INFRA_KIT_SESSION_VAR] = 'sess-seam'

  vi.mocked(getInfraKitConfig).mockResolvedValue({
    envManagement: { provider: 'doppler', config: { name: 'my-project' } },
    envAutoLoad: { trigger: 'shell-startup', config: 'dev' },
  } as never)
  vi.mocked(getInfraKitConfigPaths).mockResolvedValue({
    userProject: path.join(homeRoot, 'projects', 'seam', 'infra-kit.json'),
  } as never)
  vi.mocked(getProjectRoot).mockResolvedValue(repoRoot)
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  fs.rmSync(cacheRoot, { recursive: true, force: true })
  fs.rmSync(repoRoot, { recursive: true, force: true })
  fs.rmSync(homeRoot, { recursive: true, force: true })
})

describe('translateDopplerDownloadError — the error env-load really throws', () => {
  it('carries the auth class as a TYPE, not as text a downstream module must re-parse', () => {
    const error = translateDopplerDownloadError(dopplerFailure(REVOKED_STDERR), 'my-project', 'dev')

    expect(isDopplerAuthError(error)).toBe(true)

    // And the raw markers really ARE gone from the message — which is why text-matching them
    // downstream could only ever fail. This is the assertion that pins the bug.
    expect(error.message).not.toContain('Invalid Auth token')
    expect(error.message).toContain('infra-kit env-token-set dev')
  })

  it('classifies the mis-scoped token the CLI refused on the wire', () => {
    const error = translateDopplerDownloadError(dopplerFailure(MIS_SCOPED_STDERR), 'my-project', 'dev')

    expect(isDopplerAuthError(error)).toBe(true)
    expect(error.message).not.toContain('does not have access to requested config')
  })

  it('leaves a transient failure untouched (network / timeout are not the token)', () => {
    const cause = dopplerFailure('connect ETIMEDOUT 34.x.x.x:443')
    const error = translateDopplerDownloadError(cause, 'my-project', 'dev')

    expect(isDopplerAuthError(error)).toBe(false)
    expect(error).toBe(cause)
  })
})

describe('runEnvAutoLoad x env-load — a revoked token is LOUD (the integration bug)', () => {
  // These are the DOPPLER-REJECTED failures: they need a token to send, or the resolver would refuse
  // before Doppler is ever reached and the zx-injected error under test would never fire.
  beforeEach(withEnvToken)

  it('writes the sticky marker on the silent shell-startup spawn and warns on the next command', async () => {
    download.error = dopplerFailure(REVOKED_STDERR)

    // The backgrounded shell-startup spawn: stderr is discarded, so it must stay quiet — but it
    // MUST leave the sticky marker behind. Before the fix it left only the 30s transient flag.
    expect(await runEnvAutoLoad({ expectedTrigger: 'shell-startup', projectDir: repoRoot })).toBeNull()

    expect(logger.warn).not.toHaveBeenCalled()
    expect(fs.existsSync(markerPath())).toBe(true)
    expect(readMarker()?.config).toBe('dev')

    // The next interactive command replays it — the ONLY channel that reaches this user.
    expect(await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })).toBeNull()

    expect(logger.warn).toHaveBeenCalledOnce()
    expect(warnings()).toContain('infra-kit env-token-set dev')
  })

  it('does the same for a mis-scoped token', async () => {
    download.error = dopplerFailure(MIS_SCOPED_STDERR)

    await runEnvAutoLoad({ expectedTrigger: 'shell-startup', projectDir: repoRoot })
    await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })

    expect(fs.existsSync(markerPath())).toBe(true)
    expect(warnings()).toContain('infra-kit env-token-set dev')
  })

  it('prints no token, even when the raw stderr carried one', async () => {
    download.error = dopplerFailure(`${REVOKED_STDERR} (${TOKEN})`)

    await runEnvAutoLoad({ expectedTrigger: 'shell-startup', projectDir: repoRoot })
    await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })

    expect(warnings()).toContain('infra-kit env-token-set dev')
    expect(warnings()).not.toContain(TOKEN)
    expect(fs.readFileSync(markerPath(), 'utf-8')).not.toContain(TOKEN)
  })

  it('a transient failure records ONLY the 30s backoff flag — no sticky marker, no token advice', async () => {
    // cli-invocation on BOTH sides: this is the channel that can warn, so the transient
    // wording is observable here (the shell-startup spawn would only debug-log it).
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      environments: ['dev', 'prod'],
      envManagement: { provider: 'doppler', config: { name: 'my-project' } },
      envAutoLoad: { trigger: 'cli-invocation', config: 'dev' },
    } as never)
    download.error = dopplerFailure('connect ETIMEDOUT 34.x.x.x:443')

    await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })

    expect(fs.existsSync(path.join(getSessionCacheDir(), FAIL_SENTINEL_FILE))).toBe(true)
    expect(fs.existsSync(markerPath())).toBe(false)
    expect(warnings()).toContain('will retry later')
    expect(warnings()).not.toContain('env-token-set')
  })

  it('a successful load clears the sticky marker (the user fixed their token)', async () => {
    download.error = dopplerFailure(REVOKED_STDERR)

    await runEnvAutoLoad({ expectedTrigger: 'shell-startup', projectDir: repoRoot })

    expect(fs.existsSync(markerPath())).toBe(true)

    // A good token now. Expire the 30s transient backoff, which would otherwise skip the retry.
    download.error = null

    fs.rmSync(path.join(getSessionCacheDir(), FAIL_SENTINEL_FILE), { force: true })

    expect(await runEnvAutoLoad({ expectedTrigger: 'shell-startup', projectDir: repoRoot })).toContain('env-load.sh')
    expect(fs.existsSync(markerPath())).toBe(false)
  })
})

/**
 * THE MIGRATION CASE — no `INFRA_KIT_ENV_TOKEN`, no token store. Doppler is never reached: the
 * resolver refuses first. This is the case the whole sticky-marker feature exists to survive (a user
 * upgrades into token-only auth without having minted a token, and their shells simply go quiet), and
 * it is the case the file-wide `INFRA_KIT_ENV_TOKEN` above used to make untestable.
 *
 * No `withEnvToken()` here, deliberately. Restoring it makes every assertion below vacuous.
 */
describe('runEnvAutoLoad x token-resolver — a MISSING token is LOUD (the migration case)', () => {
  it("refuses with a TYPED auth error, not a plain one — the class is what reaches the user's terminal", async () => {
    const error = await resolveEnvToken('dev').catch((err: unknown) => {
      return err
    })

    // The mutation guard: revert this throw to `new Error(...)` and THIS is the assertion that reddens
    // first, before any of the disk/warning plumbing below has a chance to look plausible.
    expect(isEnvAuthFailure(error)).toBe(true)
    expect((error as Error).message).toContain('infra-kit env-token-set dev')
  })

  it('writes the sticky marker on the silent shell-startup spawn and warns on the next command', async () => {
    // The backgrounded spawn: stderr → /dev/null. Its ONLY channel to the human is the sticky marker.
    expect(await runEnvAutoLoad({ expectedTrigger: 'shell-startup', projectDir: repoRoot })).toBeNull()

    expect(logger.warn).not.toHaveBeenCalled()
    expect(fs.existsSync(markerPath())).toBe(true)
    expect(readMarker()?.config).toBe('dev')

    // The next interactive command replays it. Before the fix: NOTHING, ever.
    expect(await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })).toBeNull()

    expect(logger.warn).toHaveBeenCalledOnce()
    expect(warnings()).toContain('infra-kit env-token-set dev')
  })

  it('a minted token clears the marker (the user ran env-token-set)', async () => {
    await runEnvAutoLoad({ expectedTrigger: 'shell-startup', projectDir: repoRoot })

    expect(fs.existsSync(markerPath())).toBe(true)

    withEnvToken()

    fs.rmSync(path.join(getSessionCacheDir(), FAIL_SENTINEL_FILE), { force: true })

    expect(await runEnvAutoLoad({ expectedTrigger: 'shell-startup', projectDir: repoRoot })).toContain('env-load.sh')
    expect(fs.existsSync(markerPath())).toBe(false)
  })
})

/**
 * A CORRUPT TOKEN STORE — the resolver never even runs, `readTokenStore` throws underneath it. The
 * most DURABLE failure of the three: a 30s retry cannot heal a file full of garbage, only a human can.
 * The store lives a layer BELOW Doppler, which is why the auth class it throws has to be the neutral
 * `EnvAuthError` and not a Doppler-owned type.
 */
describe('runEnvAutoLoad x env-tokens — a CORRUPT token store is LOUD', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true })
    fs.writeFileSync(storePath(), '{ not json at all', { mode: 0o600 })
  })

  it('writes the sticky marker on the silent shell-startup spawn and warns on the next command', async () => {
    expect(await runEnvAutoLoad({ expectedTrigger: 'shell-startup', projectDir: repoRoot })).toBeNull()

    expect(logger.warn).not.toHaveBeenCalled()
    expect(fs.existsSync(markerPath())).toBe(true)
    expect(readMarker()?.reason).toContain('Invalid JSON in the token store')

    expect(await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })).toBeNull()

    expect(warnings()).toContain('infra-kit env-token-set dev')

    // The wording has to hold for a store that is neither "invalid" nor "missing" a token.
    expect(warnings()).toContain('unreadable')
  })

  it('is not confused for a transient failure (no 30s-expiring flag ALONE)', async () => {
    await runEnvAutoLoad({ expectedTrigger: 'shell-startup', projectDir: repoRoot })

    // The transient flag is still written (it also throttles retries) — but it MUST NOT be the only
    // thing written, because it expires in 30s and this failure never does.
    expect(fs.existsSync(path.join(getSessionCacheDir(), FAIL_SENTINEL_FILE))).toBe(true)
    expect(fs.existsSync(markerPath())).toBe(true)
  })
})
