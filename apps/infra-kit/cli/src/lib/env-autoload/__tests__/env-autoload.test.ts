import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeEnvLoadFile } from 'src/commands/env-load'
import {
  INFRA_KIT_ENV_AUTOLOADED_VAR,
  INFRA_KIT_ENV_CLEARED_VAR,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  INFRA_KIT_SESSION_VAR,
} from 'src/lib/constants'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

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

const baseConfig = {
  environments: ['dev', 'prod'],
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

  it('warns and disables when config is not one of environments', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'nope' },
    } as never)

    expect(await resolveEnvAutoLoad()).toBeNull()
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toContain('nope')
  })

  // Gap 1 regression: the shell-startup callsite discards stderr, so it must NOT
  // warn (and must not write the dedup flag that would poison the interactive channel).
  it('does NOT warn on bad config when canWarn is false (shell-startup channel)', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({
      ...baseConfig,
      envAutoLoad: { trigger: 'shell-startup', config: 'nope' },
    } as never)

    expect(await resolveEnvAutoLoad(false)).toBeNull()
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
    expect(writeEnvLoadFile).toHaveBeenCalledWith({ config: 'dev', autoLoaded: true })
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
