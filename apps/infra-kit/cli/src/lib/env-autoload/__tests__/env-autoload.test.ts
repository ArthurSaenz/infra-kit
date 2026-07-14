import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeEnvLoadFile } from 'src/commands/env-load'
import { DopplerAuthError, isDopplerAuthError } from 'src/integrations/doppler'
import { envTokenExists } from 'src/integrations/doppler/token-resolver'
import {
  INFRA_KIT_ENV_AUTOLOADED_VAR,
  INFRA_KIT_ENV_CLEARED_VAR,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  INFRA_KIT_SESSION_VAR,
  getSessionCacheDir,
} from 'src/lib/constants'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import { buildAuthFailureWarning, parseAuthFailureMarker } from '../auth-failure'
import { decideAutoLoad, resolveEnvAutoLoad, runEnvAutoLoad } from '../env-autoload'
import type { AutoLoadDecisionInput, AutoLoadEnvSnapshot } from '../env-autoload'

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/commands/env-load', () => {
  return { writeEnvLoadFile: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { warn: vi.fn(), debug: vi.fn() } }
})

// The "is this env usable?" gate `resolveEnvAutoLoad` reads — a local token-store check, never
// Doppler. Preserve every other export of the module (resolveEnvToken, INFRA_KIT_ENV_TOKEN_VAR) so
// only this one seam is faked.
vi.mock('src/integrations/doppler/token-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/integrations/doppler/token-resolver')>()

  return { ...actual, envTokenExists: vi.fn() }
})

// Default: a token exists for whatever env is configured, so every test that does not care about
// this gate keeps behaving as if auto-load's token check passed. Tests of the gate itself override it.
beforeEach(() => {
  vi.mocked(envTokenExists).mockReset().mockResolvedValue(true)
})

const baseConfig = {
  envManagement: { provider: 'doppler', config: { name: 'my-project' } },
}

const buildInput = (overrides: Partial<AutoLoadDecisionInput> = {}): AutoLoadDecisionInput => {
  return {
    trigger: 'cli-invocation',
    expectedTrigger: 'cli-invocation',
    targetConfig: 'dev',
    targetProject: 'my-project',
    env: { session: 'sess-1' },
    ...overrides,
  }
}

const loadedEnv = (overrides: Partial<AutoLoadEnvSnapshot> = {}): AutoLoadEnvSnapshot => {
  return {
    session: 'sess-1',
    currentConfig: 'dev',
    currentProject: 'my-project',
    autoLoadedMarker: '1',
    ...overrides,
  }
}

describe('decideAutoLoad — trigger gating', () => {
  it('loads when the configured trigger matches this callsite', () => {
    expect(decideAutoLoad(buildInput({ trigger: 'cli-invocation', expectedTrigger: 'cli-invocation' }))).toBe('load')
    expect(decideAutoLoad(buildInput({ trigger: 'shell-startup', expectedTrigger: 'shell-startup' }))).toBe('load')
  })

  it('skips when the configured trigger is for the other callsite', () => {
    expect(decideAutoLoad(buildInput({ trigger: 'shell-startup', expectedTrigger: 'cli-invocation' }))).toBe('skip')
    expect(decideAutoLoad(buildInput({ trigger: 'cli-invocation', expectedTrigger: 'shell-startup' }))).toBe('skip')
  })
})

describe('decideAutoLoad — session + clear guards', () => {
  it('skips when no session is set (cache dir is session-scoped)', () => {
    expect(decideAutoLoad(buildInput({ env: { session: undefined } }))).toBe('skip')
  })

  // Regression M2: a deliberate `env-clear` must keep cli-invocation auto-load
  // from immediately re-loading in the same shell.
  it('skips when the clear sentinel is set (M2: stay cleared)', () => {
    expect(decideAutoLoad(buildInput({ env: { session: 'sess-1', cleared: '1' } }))).toBe('skip')
  })
})

describe('decideAutoLoad — manual-load protection (C1)', () => {
  // Regression C1: env loaded WITHOUT our auto marker means a manual `env-load`;
  // auto-load must never overwrite it, even when the target config differs.
  it('skips a manually-loaded env even when target config differs', () => {
    expect(
      decideAutoLoad(
        buildInput({
          targetConfig: 'dev',
          env: { session: 'sess-1', currentConfig: 'prod', currentProject: 'my-project', autoLoadedMarker: undefined },
        }),
      ),
    ).toBe('skip')
  })
})

describe('decideAutoLoad — project-aware freshness', () => {
  it('skips when our auto-load already matches config AND project', () => {
    expect(decideAutoLoad(buildInput({ env: loadedEnv() }))).toBe('skip')
  })

  it('loads when the auto-loaded config differs from target', () => {
    expect(decideAutoLoad(buildInput({ targetConfig: 'prod', env: loadedEnv({ currentConfig: 'dev' }) }))).toBe('load')
  })

  it('loads when the project differs even though the config name matches (worktree leak guard)', () => {
    expect(
      decideAutoLoad(buildInput({ targetProject: 'other-project', env: loadedEnv({ currentProject: 'my-project' }) })),
    ).toBe('load')
  })

  it('loads into a clean shell (nothing currently loaded)', () => {
    expect(decideAutoLoad(buildInput({ env: { session: 'sess-1' } }))).toBe('load')
  })
})

describe('decideAutoLoad — force (shell-startup warm refresh)', () => {
  // Regression for the warm-cache refresh defect: after a WARM source the shell has
  // exported the auto-load marker + same config, which the backgrounded refresh
  // inherits. Without `force` the refresh self-skips and stale warm secrets persist.
  it('forces a fresh load past the same-config no-op skip', () => {
    expect(decideAutoLoad(buildInput({ env: loadedEnv() }))).toBe('skip')
    expect(decideAutoLoad(buildInput({ env: loadedEnv(), force: true }))).toBe('load')
  })

  it('force does NOT override the clear guard', () => {
    expect(decideAutoLoad(buildInput({ env: loadedEnv({ cleared: '1' }), force: true }))).toBe('skip')
  })

  it('force does NOT override the manual-load guard', () => {
    expect(
      decideAutoLoad(
        buildInput({
          env: { session: 'sess-1', currentConfig: 'prod', currentProject: 'my-project', autoLoadedMarker: undefined },
          force: true,
        }),
      ),
    ).toBe('skip')
  })
})

describe('resolveEnvAutoLoad', () => {
  const ORIGINAL_ENV = { ...process.env }
  let cacheRoot: string

  beforeEach(() => {
    vi.mocked(getInfraKitConfig).mockReset()
    vi.mocked(logger.warn).mockClear()
    // Isolate the per-session warn-dedup flag in a fresh cache dir so the warning
    // is not suppressed by a flag left over from the dev's real session.
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-autoload-resolve-'))
    process.env.XDG_CACHE_HOME = cacheRoot
    process.env[INFRA_KIT_SESSION_VAR] = 'sess-resolve'
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    fs.rmSync(cacheRoot, { recursive: true, force: true })
  })

  it('returns null when not inside a project (getInfraKitConfig throws)', async () => {
    vi.mocked(getInfraKitConfig).mockRejectedValue(new Error('infra-kit.json not found'))

    expect(await resolveEnvAutoLoad()).toBeNull()
  })

  it('returns null when envAutoLoad is absent (feature off)', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue(baseConfig as never)

    expect(await resolveEnvAutoLoad()).toBeNull()
  })

  it('resolves trigger + config + project from one config read', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'cli-invocation', config: 'dev' },
    } as never)

    expect(await resolveEnvAutoLoad()).toEqual({ trigger: 'cli-invocation', config: 'dev', project: 'my-project' })
  })

  // The authority for "is this env usable?" is the token store (`envTokenExists`), not a
  // hand-maintained `environments` list — that key is gone from the schema entirely.
  it('warns and disables when no token exists for envAutoLoad.config', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'nope' },
    } as never)
    vi.mocked(envTokenExists).mockResolvedValue(false)

    expect(await resolveEnvAutoLoad()).toBeNull()
    expect(envTokenExists).toHaveBeenCalledWith('nope')
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toContain('nope')
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toContain('infra-kit env-token-set nope')
    // The gate is a local file read (the token store), never a Doppler network call — nothing here
    // reaches the download path.
    expect(writeEnvLoadFile).not.toHaveBeenCalled()
  })

  // Gap 1 regression: the shell-startup callsite discards stderr, so it must NOT
  // warn (and must not write the dedup flag that would poison the interactive channel).
  it('does NOT warn on bad config when canWarn is false (shell-startup channel)', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'nope' },
    } as never)
    vi.mocked(envTokenExists).mockResolvedValue(false)

    expect(await resolveEnvAutoLoad(false)).toBeNull()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // The store itself is broken — a durable failure a 30s retry cannot heal, and a completely
  // different case from "no token yet". Disabling quietly here would hide it forever on the
  // backgrounded shell-startup channel; proceeding lets the downstream EnvAuthError's sticky
  // marker surface it instead.
  it('returns the resolved config (does NOT silently disable) when the token store is corrupt', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'cli-invocation', config: 'dev' },
    } as never)
    vi.mocked(envTokenExists).mockRejectedValue(new Error('Invalid JSON in the token store'))

    expect(await resolveEnvAutoLoad()).toEqual({ trigger: 'cli-invocation', config: 'dev', project: 'my-project' })
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('runEnvAutoLoad', () => {
  const ORIGINAL_ENV = { ...process.env }
  let cacheRoot: string

  beforeEach(() => {
    vi.mocked(getInfraKitConfig).mockReset()
    vi.mocked(writeEnvLoadFile).mockReset()
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-autoload-'))
    process.env.XDG_CACHE_HOME = cacheRoot
    process.env[INFRA_KIT_SESSION_VAR] = 'sess-run'
    delete process.env[INFRA_KIT_ENV_CONFIG_VAR]
    delete process.env[INFRA_KIT_ENV_PROJECT_VAR]
    delete process.env[INFRA_KIT_ENV_AUTOLOADED_VAR]
    delete process.env[INFRA_KIT_ENV_CLEARED_VAR]
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    fs.rmSync(cacheRoot, { recursive: true, force: true })
  })

  it('writes an auto-loaded file and returns its path on load', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'dev' },
    } as never)
    vi.mocked(writeEnvLoadFile).mockResolvedValue({
      filePath: '/cache/env-load.sh',
      variableCount: 3,
      project: 'my-project',
      config: 'dev',
    })

    const result = await runEnvAutoLoad({ expectedTrigger: 'shell-startup' })

    expect(result).toBe('/cache/env-load.sh')
    expect(writeEnvLoadFile).toHaveBeenCalledWith(expect.objectContaining({ config: 'dev', autoLoaded: true }))
  })

  it('returns null without throwing or warning when the write is aborted (beforeWrite returned false)', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'cli-invocation', config: 'dev' },
    } as never)
    vi.mocked(writeEnvLoadFile).mockResolvedValue(null)

    const result = await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })

    expect(result).toBeNull()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('returns null without fetching when the configured trigger is for the other callsite', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'dev' },
    } as never)

    const result = await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })

    expect(result).toBeNull()
    expect(writeEnvLoadFile).not.toHaveBeenCalled()
  })

  it('returns null and never fetches when env is already fresh', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'cli-invocation', config: 'dev' },
    } as never)
    process.env[INFRA_KIT_ENV_CONFIG_VAR] = 'dev'
    process.env[INFRA_KIT_ENV_PROJECT_VAR] = 'my-project'
    process.env[INFRA_KIT_ENV_AUTOLOADED_VAR] = '1'

    const result = await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })

    expect(result).toBeNull()
    expect(writeEnvLoadFile).not.toHaveBeenCalled()
  })

  it('swallows transient failures to a debug log (shell-startup) and returns null', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'dev' },
    } as never)
    vi.mocked(writeEnvLoadFile).mockRejectedValue(new Error('doppler not authenticated'))

    const result = await runEnvAutoLoad({ expectedTrigger: 'shell-startup' })

    expect(result).toBeNull()
    expect(logger.debug).toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('surfaces a transient failure once on the cli-invocation channel', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'cli-invocation', config: 'dev' },
    } as never)
    vi.mocked(writeEnvLoadFile).mockRejectedValue(new Error('doppler not authenticated'))

    const result = await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })

    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toContain('failed')
  })

  it('backs off: after a failure the next run skips Doppler (writeEnvLoadFile called once)', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'cli-invocation', config: 'dev' },
    } as never)
    vi.mocked(writeEnvLoadFile).mockRejectedValue(new Error('network down'))

    expect(await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })).toBeNull()
    expect(await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })).toBeNull()

    expect(writeEnvLoadFile).toHaveBeenCalledOnce()
  })
})

describe('auth-class classification (pure)', () => {
  // The default classifier is now a TYPE GUARD over the error env-load actually throws.
  // It used to text-match Doppler's RAW stderr markers — which env-load had already
  // replaced with its friendly message by the time this code saw the error, so the
  // auth branch never fired. See `env-autoload-doppler-seam.test.ts`.
  it('classifies the typed auth error env-load throws', () => {
    expect(isDopplerAuthError(new DopplerAuthError('dev', 'revoked'))).toBe(true)
    expect(isDopplerAuthError(new DopplerAuthError('dev', 'mis-scoped'))).toBe(true)
  })

  it('does NOT classify a transient failure as auth-class', () => {
    expect(isDopplerAuthError(new Error('network unreachable'))).toBe(false)
    expect(isDopplerAuthError(new Error("Doppler Error: Could not find requested config 'dev'"))).toBe(false)
  })

  it('rejects a corrupt marker payload instead of throwing', () => {
    expect(parseAuthFailureMarker({ config: 'dev', reason: 'Invalid Auth token', at: 1 })).toEqual({
      config: 'dev',
      reason: 'Invalid Auth token',
      at: 1,
    })
    expect(parseAuthFailureMarker({ config: 'dev' })).toBeNull()
    expect(parseAuthFailureMarker(null)).toBeNull()
    expect(parseAuthFailureMarker('nonsense')).toBeNull()
  })

  it('builds a one-line actionable warning naming the env and the fix command', () => {
    const message = buildAuthFailureWarning('dev')

    expect(message).not.toContain('\n')
    expect(message).toContain('"dev"')
    expect(message).toContain('infra-kit env-token-set dev')
  })
})

const AUTH_FAIL_MARKER_FILE = 'autoload-auth-fail.json'

/**
 * The error `env-load` ACTUALLY throws for a revoked/mis-scoped token: a typed
 * `DopplerAuthError` whose message is the friendly, translated one — NOT Doppler's raw
 * stderr. These tests used to hand-roll `new Error('Doppler Error: Invalid Auth token')`,
 * a shape the production path never produces, and passed while the real path was silent.
 * `env-autoload-doppler-seam.test.ts` builds this error via the real translator.
 */
const authError = (): DopplerAuthError => {
  return new DopplerAuthError('dev', 'revoked')
}

describe('runEnvAutoLoad — sticky auth-failure marker (US-005)', () => {
  const ORIGINAL_ENV = { ...process.env }
  let cacheRoot: string

  const markerPath = (): string => {
    return path.join(getSessionCacheDir(), AUTH_FAIL_MARKER_FILE)
  }

  beforeEach(() => {
    vi.mocked(getInfraKitConfig).mockReset()
    vi.mocked(writeEnvLoadFile).mockReset()
    vi.mocked(logger.warn).mockClear()
    vi.mocked(logger.debug).mockClear()
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-autoload-auth-'))

    // Scrub EVERY INFRA_KIT_* var: a leaked INFRA_KIT_SESSION from the dev's real
    // shell silently repoints the session cache dir and makes every assertion below
    // vacuous (the marker would be written/read somewhere we never look).
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('INFRA_KIT_')) {
        delete process.env[key]
      }
    }

    process.env.XDG_CACHE_HOME = cacheRoot
    process.env[INFRA_KIT_SESSION_VAR] = 'sess-auth'
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    fs.rmSync(cacheRoot, { recursive: true, force: true })
  })

  // THE load-bearing regression. The user's configured trigger is shell-startup (the
  // default), so decideAutoLoad skips this cli-invocation callsite outright — and the
  // shell-startup spawn that actually failed runs backgrounded with stderr discarded
  // (canWarn === false there). Before US-005 this combination warned NOTHING, ever.
  it('warns on trigger:shell-startup x expectedTrigger:cli-invocation — the combination that was silent', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'dev' },
    } as never)

    // The backgrounded shell-startup run hits an auth failure and stays silent.
    vi.mocked(writeEnvLoadFile).mockRejectedValue(authError())

    expect(await runEnvAutoLoad({ expectedTrigger: 'shell-startup' })).toBeNull()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(fs.existsSync(markerPath())).toBe(true)

    // The next interactive command replays it, even though decideAutoLoad would skip.
    vi.mocked(writeEnvLoadFile).mockClear()

    expect(await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })).toBeNull()

    expect(writeEnvLoadFile).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toContain('infra-kit env-token-set dev')
  })

  // The end-to-end version of this — a token-bearing RAW stderr fed through the real
  // translator — lives in `env-autoload-doppler-seam.test.ts`.
  it('never prints a token value in the warning', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'dev' },
    } as never)
    vi.mocked(writeEnvLoadFile).mockRejectedValue(authError())

    await runEnvAutoLoad({ expectedTrigger: 'shell-startup' })
    await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })

    expect(vi.mocked(logger.warn).mock.calls[0]![0]).not.toContain('dp.st.')
  })

  // Unlike the transient FAIL_BACKOFF_MS flag, the auth marker has no timer: a bad
  // token does not heal in 30s, and the human who can fix it may not run an
  // interactive command for hours.
  it('is NOT expired by the 30s transient backoff window', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'dev' },
    } as never)
    vi.mocked(writeEnvLoadFile).mockRejectedValue(authError())

    await runEnvAutoLoad({ expectedTrigger: 'shell-startup' })

    // Age both markers well past FAIL_BACKOFF_MS (30s).
    const longAgo = new Date(Date.now() - 10 * 60 * 1000)

    fs.utimesSync(markerPath(), longAgo, longAgo)

    expect(await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })).toBeNull()

    expect(fs.existsSync(markerPath())).toBe(true)
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toContain('infra-kit env-token-set dev')
  })

  it('a successful load clears the sticky marker', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'cli-invocation', config: 'dev' },
    } as never)
    vi.mocked(writeEnvLoadFile).mockRejectedValueOnce(authError()).mockResolvedValue({
      filePath: '/cache/env-load.sh',
      variableCount: 3,
      project: 'my-project',
      config: 'dev',
    })

    expect(await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })).toBeNull()
    expect(fs.existsSync(markerPath())).toBe(true)

    // The 30s transient backoff would suppress the retry — expire it, not the marker.
    fs.rmSync(path.join(getSessionCacheDir(), 'autoload-fail.flag'), { force: true })

    expect(await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })).toBe('/cache/env-load.sh')
    expect(fs.existsSync(markerPath())).toBe(false)
  })

  it('never throws (and stays silent) when the marker file is corrupt', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'dev' },
    } as never)

    fs.mkdirSync(getSessionCacheDir(), { recursive: true, mode: 0o700 })
    fs.writeFileSync(markerPath(), '{ not json at all')

    await expect(runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })).resolves.toBeNull()

    expect(logger.warn).not.toHaveBeenCalled()
  })

  // The classifier is injected, so US-002 can hand env-autoload the doppler-errors
  // implementation without env-autoload importing it.
  it('accepts an injected auth classifier (the US-002 seam)', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'cli-invocation', config: 'dev' },
    } as never)
    vi.mocked(writeEnvLoadFile).mockRejectedValue(new Error('some future auth wording'))

    await runEnvAutoLoad({
      expectedTrigger: 'cli-invocation',
      isAuthFailure: () => {
        return true
      },
    })

    expect(fs.existsSync(markerPath())).toBe(true)
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toContain('infra-kit env-token-set dev')
  })

  it('a transient failure does NOT write the sticky marker', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'cli-invocation', config: 'dev' },
    } as never)
    vi.mocked(writeEnvLoadFile).mockRejectedValue(new Error('network unreachable'))

    await runEnvAutoLoad({ expectedTrigger: 'cli-invocation' })

    expect(fs.existsSync(markerPath())).toBe(false)
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toContain('will retry later')
  })
})
