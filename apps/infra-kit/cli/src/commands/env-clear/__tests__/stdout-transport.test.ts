import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { envLoad } from 'src/commands/env-load'
import { INFRA_KIT_ENV_TOKEN_VAR } from 'src/integrations/doppler'
import { ENV_CLEAR_FILE, ENV_LOAD_FILE, INFRA_KIT_SESSION_VAR, getSessionCacheDir } from 'src/lib/constants'
import { getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'

import { envClear } from '../env-clear'

/**
 * `envLoad` and `envClear` are the handlers behind BOTH `infra-kit env-load` and the MCP tools of the
 * same name. Over `infra-kit mcp`, stdout is the JSON-RPC transport: a bare path line between frames
 * is a corrupt message that only a tolerant client survives (the v1 SDK routes it to `onerror` and
 * reads on; a strict host drops the connection). The path the zsh wrapper captures is therefore the
 * CLI action's to print, and these tests pin that the handlers never touch stdout themselves.
 */

const { download } = vi.hoisted(() => {
  return { download: { stdout: '{}' } }
})

vi.mock('zx', () => {
  const tagged = () => {
    return () => {
      return {
        timeout: () => {
          return Promise.resolve({ stdout: download.stdout })
        },
      }
    }
  }

  return { $: vi.fn(tagged) }
})

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/lib/git-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/git-utils')>()

  return { ...actual, getProjectRoot: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }
})

const ORIGINAL_ENV = { ...process.env }

let cacheRoot = ''
let repoRoot = ''
let stdoutWrite: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()

  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-stdout-transport-'))
  repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-stdout-repo-')))

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INFRA_KIT_')) {
      delete process.env[key]
    }
  }

  process.env.XDG_CACHE_HOME = cacheRoot
  process.env[INFRA_KIT_SESSION_VAR] = 'sess-stdout'
  process.env[INFRA_KIT_ENV_TOKEN_VAR] = 'dp.st.dev.NOT_A_REAL_TOKEN'

  download.stdout = JSON.stringify({
    DOPPLER_CONFIG: 'dev',
    DOPPLER_ENVIRONMENT: 'dev',
    DOPPLER_PROJECT: 'my-project',
    HELLO: 'world',
  })

  vi.mocked(getInfraKitConfig).mockResolvedValue({
    envManagement: { provider: 'doppler', config: { name: 'my-project' } },
  } as never)
  vi.mocked(getProjectRoot).mockResolvedValue(repoRoot)

  // A spy, not a replacement: a real write would still reach the terminal AND be counted.
  stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
    return true
  })
})

afterEach(() => {
  stdoutWrite.mockRestore()
  process.env = { ...ORIGINAL_ENV }
  fs.rmSync(cacheRoot, { recursive: true, force: true })
  fs.rmSync(repoRoot, { recursive: true, force: true })
})

describe('the env handlers keep stdout clean — it is the MCP transport', () => {
  it('envLoad returns the path in structuredContent and writes nothing to stdout', async () => {
    const result = await envLoad({ config: 'dev' })

    expect(result.structuredContent.filePath).toBe(path.join(getSessionCacheDir(), ENV_LOAD_FILE))
    expect(fs.existsSync(result.structuredContent.filePath)).toBe(true)
    expect(stdoutWrite).not.toHaveBeenCalled()
  })

  it('envClear returns the path in structuredContent and writes nothing to stdout', async () => {
    await envLoad({ config: 'dev' })
    stdoutWrite.mockClear()

    const result = await envClear()

    expect(result.structuredContent.filePath).toBe(path.join(getSessionCacheDir(), ENV_CLEAR_FILE))
    expect(fs.existsSync(result.structuredContent.filePath)).toBe(true)
    expect(stdoutWrite).not.toHaveBeenCalled()
  })
})
