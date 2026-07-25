import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { mcpMode } from 'src/lib/mcp-mode'

import { getInfraKitConfig, resetInfraKitConfigCache } from '../infra-kit-config'

// Real config module, mocked git-utils: a config-less tmpdir stands in for "this git repo is not an
// infra-kit project" so the REAL `getInfraKitConfig` missing-config throw (Step 4) is exercised.
vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getMainRepoRoot: vi.fn(),
    getRepoName: vi.fn(),
  }
})

let tmp: string
let homedirSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-fail-honestly-'))
  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getMainRepoRoot).mockResolvedValue(tmp)
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp)
  mcpMode.enabled = false
  resetInfraKitConfigCache()
})

afterEach(() => {
  mcpMode.enabled = false
  homedirSpy.mockRestore()
  resetInfraKitConfigCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('getInfraKitConfig — missing layer-1 config (Step 4 prefix stability)', () => {
  it('cLI channel: message STARTS WITH the byte-identical `infra-kit.json not found at ` prefix', async () => {
    const err = await getInfraKitConfig().catch((e: unknown) => {
      return e
    })

    const message = (err as Error).message

    // startsWith, not includes — the prefix that `doctor` surfaces verbatim must remain the head.
    expect(message.startsWith('infra-kit.json not found at ')).toBe(true)
    expect(message).toContain(path.join(tmp, 'infra-kit.json'))
    expect(message).toContain('this git repo is not an infra-kit project')
  })

  it('mCP channel: message STARTS WITH the same prefix and names neither `cd ` nor `--project` (Step 3)', async () => {
    mcpMode.enabled = true

    const err = await getInfraKitConfig().catch((e: unknown) => {
      return e
    })

    const message = (err as Error).message

    expect(message.startsWith('infra-kit.json not found at ')).toBe(true)
    expect(message).toContain('the infra-kit MCP server was launched in')
    expect(message).not.toContain('cd ')
    expect(message).not.toContain('--project')
  })

  it('legacy-YAML branch is unchanged: points at the infra-kit.yml migration', async () => {
    fs.writeFileSync(path.join(tmp, 'infra-kit.yml'), 'legacy: true\n')

    const err = await getInfraKitConfig().catch((e: unknown) => {
      return e
    })

    const message = (err as Error).message

    expect(message.startsWith('infra-kit.json not found at ')).toBe(true)
    expect(message).toContain('A legacy infra-kit.yml exists')
    expect(message).toContain('`infra-kit init`')
  })
})
