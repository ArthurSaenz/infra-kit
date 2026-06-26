import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  INFRA_KIT_ENV_AUTOLOADED_VAR,
  INFRA_KIT_ENV_CLEARED_VAR,
  INFRA_KIT_ENV_CONFIG_VAR,
  INFRA_KIT_ENV_PROJECT_VAR,
  INFRA_KIT_SESSION_VAR,
} from 'src/lib/constants'

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
  delete process.env[INFRA_KIT_ENV_AUTOLOADED_VAR]
  delete process.env[INFRA_KIT_ENV_CLEARED_VAR]
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  fs.rmSync(cacheRoot, { recursive: true, force: true })
})

describe('envStatus', () => {
  it('reports nothing loaded with autoLoaded=false, cleared=false', async () => {
    const { structuredContent } = await envStatus()

    expect(structuredContent.sessionConfig).toBeNull()
    expect(structuredContent.autoLoaded).toBe(false)
    expect(structuredContent.cleared).toBe(false)
  })

  it('reports cleared=true when the clear sentinel is set', async () => {
    process.env[INFRA_KIT_ENV_CLEARED_VAR] = '1'

    const { structuredContent } = await envStatus()

    expect(structuredContent.cleared).toBe(true)
  })

  it('reports autoLoaded=true when the auto-load marker is present', async () => {
    process.env[INFRA_KIT_ENV_CONFIG_VAR] = 'dev'
    process.env[INFRA_KIT_ENV_PROJECT_VAR] = 'my-project'
    process.env[INFRA_KIT_ENV_AUTOLOADED_VAR] = '1'

    const { structuredContent } = await envStatus()

    expect(structuredContent.sessionConfig).toBe('dev')
    expect(structuredContent.autoLoaded).toBe(true)
  })

  it('reports autoLoaded=false for a manual load (config set, no marker)', async () => {
    process.env[INFRA_KIT_ENV_CONFIG_VAR] = 'dev'

    const { structuredContent } = await envStatus()

    expect(structuredContent.autoLoaded).toBe(false)
  })
})
