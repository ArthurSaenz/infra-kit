import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configUnset } from 'src/commands/config-unset'
import { agentMode } from 'src/lib/agent-mode'
import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'

import { configSet, parseConfigValue } from '../config-set'

vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn(), getMainRepoRoot: vi.fn(), getRepoName: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }
})

const PROJECT_CONFIG = {
  envManagement: { provider: 'doppler', config: { name: 'example-project' } },
  protectedEnvs: 'allow',
}

let home: string
let repo: string
let projectLayer: string
let globalLayer: string

const readJson = (file: string): Record<string, unknown> => {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'config-set-home-'))
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'config-set-repo-')))

  fs.writeFileSync(path.join(repo, 'infra-kit.json'), JSON.stringify(PROJECT_CONFIG))

  projectLayer = path.join(home, '.infra-kit', 'projects', path.basename(repo), 'infra-kit.json')
  globalLayer = path.join(home, '.infra-kit', 'infra-kit.json')

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

  resetInfraKitConfigCache()
})

afterEach(() => {
  agentMode.source = null
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('parseConfigValue', () => {
  it('reads JSON when it parses, a bare string otherwise', () => {
    expect(parseConfigValue('cli-only')).toBe('cli-only')
    expect(parseConfigValue('{"a":1}')).toEqual({ a: 1 })
    expect(parseConfigValue('true')).toBe(true)
  })
})

describe('config-set', () => {
  it('writes the per-project override and never the committed file', async () => {
    const result = await configSet({ key: 'protectedEnvs', value: 'cli-only' })

    expect(readJson(projectLayer)).toEqual({ protectedEnvs: 'cli-only' })
    expect(readJson(path.join(repo, 'infra-kit.json'))).toEqual(PROJECT_CONFIG)
    expect(result.structuredContent).toMatchObject({ scope: 'project', value: 'cli-only', previous: null })
  })

  it('--global writes the user-global layer', async () => {
    await configSet({ key: 'protectedEnvs', value: 'disallow', global: true })

    expect(readJson(globalLayer)).toEqual({ protectedEnvs: 'disallow' })
    expect(fs.existsSync(projectLayer)).toBe(false)
  })

  it('keeps the other keys already in the layer and reports the previous value', async () => {
    fs.mkdirSync(path.dirname(projectLayer), { recursive: true })
    fs.writeFileSync(projectLayer, JSON.stringify({ protectedEnvs: 'disallow', devServersPresets: {} }))

    const result = await configSet({ key: 'protectedEnvs', value: 'cli-only' })

    expect(readJson(projectLayer)).toEqual({ protectedEnvs: 'cli-only', devServersPresets: {} })
    expect(result.structuredContent.previous).toBe('disallow')
  })

  it('restores the layer when the loader refuses the result', async () => {
    fs.mkdirSync(path.dirname(projectLayer), { recursive: true })
    fs.writeFileSync(projectLayer, '{ "protectedEnvs": "disallow" }\n')

    await expect(configSet({ key: 'protectedEnvs', value: 'sometimes' })).rejects.toThrow(/left unchanged/)

    expect(fs.readFileSync(projectLayer, 'utf8')).toBe('{ "protectedEnvs": "disallow" }\n')
  })

  it('refuses a project-only key through the loader, removing the file it created', async () => {
    await expect(configSet({ key: 'audit', value: '{}' })).rejects.toThrow(/"audit" is not allowed/)

    expect(fs.existsSync(projectLayer)).toBe(false)
  })

  it('refuses nested and unknown keys before touching disk', async () => {
    await expect(configSet({ key: 'dev.port', value: '3000' })).rejects.toThrow(/replace the whole "dev" section/)
    await expect(configSet({ key: 'nope', value: '1' })).rejects.toThrow(/Unknown config key "nope"/)

    expect(fs.existsSync(projectLayer)).toBe(false)
  })

  it('refuses an agent writing protectedEnvs — it gates the agent itself', async () => {
    agentMode.source = 'flag'

    await expect(configSet({ key: 'protectedEnvs', value: 'allow' })).rejects.toMatchObject({
      structuredContent: { status: 'refused' },
    })
    await expect(configUnset({ key: 'protectedEnvs' })).rejects.toMatchObject({
      structuredContent: { status: 'refused' },
    })
  })
})

describe('config-unset', () => {
  it('removes the key so the layer below shows through', async () => {
    fs.mkdirSync(path.dirname(projectLayer), { recursive: true })
    fs.writeFileSync(projectLayer, JSON.stringify({ protectedEnvs: 'disallow', devServersPresets: {} }))

    const result = await configUnset({ key: 'protectedEnvs' })

    expect(readJson(projectLayer)).toEqual({ devServersPresets: {} })
    expect(result.structuredContent).toMatchObject({ removed: true, previous: 'disallow' })
  })

  it('is a no-op for a key the layer does not hold', async () => {
    const result = await configUnset({ key: 'ide' })

    expect(result.structuredContent.removed).toBe(false)
    expect(fs.existsSync(projectLayer)).toBe(false)
  })
})
