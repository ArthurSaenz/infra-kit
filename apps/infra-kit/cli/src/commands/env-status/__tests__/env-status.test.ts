import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { INFRA_KIT_ENV_CONFIG_VAR, INFRA_KIT_ENV_PROJECT_VAR, INFRA_KIT_SESSION_VAR } from 'src/lib/constants'
import { logger } from 'src/lib/logger'

import { envStatus } from '../env-status'

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn() } }
})

// Pure local introspection: env-status must NOT call Doppler. If it did, importing
// this mock-free test (no doppler mock) and running offline would hang/throw — the
// fact these tests pass is itself the regression guard for the de-Doppler change.

const ORIGINAL_ENV = { ...process.env }
let cacheRoot: string

beforeEach(() => {
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-envstatus-'))
  process.env.XDG_CACHE_HOME = cacheRoot
  process.env[INFRA_KIT_SESSION_VAR] = 'sess-status'
  delete process.env[INFRA_KIT_ENV_CONFIG_VAR]
  delete process.env[INFRA_KIT_ENV_PROJECT_VAR]
  vi.mocked(logger.info).mockClear()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  fs.rmSync(cacheRoot, { recursive: true, force: true })
})

describe('envStatus', () => {
  it('reports nothing loaded when no config is in the environment', async () => {
    const { structuredContent } = await envStatus()

    expect(structuredContent.sessionConfig).toBeNull()
    expect(structuredContent.sessionLoadedCount).toBe(0)
    expect(vi.mocked(logger.info).mock.calls.at(-1)?.[0]).toBe('  Session sess-status: no env loaded\n')
  })

  it('reports the loaded config and project', async () => {
    process.env[INFRA_KIT_ENV_CONFIG_VAR] = 'dev'
    process.env[INFRA_KIT_ENV_PROJECT_VAR] = 'my-project'

    const { structuredContent } = await envStatus()

    expect(structuredContent.sessionConfig).toBe('dev')
    expect(structuredContent.sessionProject).toBe('my-project')
    expect(structuredContent).not.toHaveProperty('autoLoaded')
    expect(structuredContent).not.toHaveProperty('cleared')
  })
})
