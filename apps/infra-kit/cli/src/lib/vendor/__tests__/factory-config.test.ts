import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { expandTilde, getFactoryConfigPath, loadFactoryConfig } from '../factory-config'

let home: string
let configDir: string
let configPath: string

const writeConfig = (body: string): void => {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configPath, body, 'utf8')
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-config-test-'))
  // getFactoryConfigPath() resolves under os.homedir(); point it at the fixture.
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  configDir = path.join(home, '.infra-kit')
  configPath = path.join(configDir, 'vendor.json')
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('expandTilde', () => {
  it('expands a bare ~ to the home dir', () => {
    expect(expandTilde('~')).toBe(home)
  })

  it('expands ~/x to a home-relative path', () => {
    expect(expandTilde('~/projects')).toBe(path.join(home, 'projects'))
  })

  it('passes an absolute path through unchanged', () => {
    expect(expandTilde('/abs/dir')).toBe('/abs/dir')
  })

  it('throws on a non-absolute, non-~ path', () => {
    expect(() => {
      return expandTilde('rel/dir')
    }).toThrow(/must be absolute or ~-prefixed/)
  })
})

describe('getFactoryConfigPath', () => {
  it('points at ~/.infra-kit/vendor.json', () => {
    expect(getFactoryConfigPath()).toBe(configPath)
  })
})

describe('loadFactoryConfig', () => {
  it('loads a JSON config', async () => {
    writeConfig(JSON.stringify({ workspaceDir: '~/projects', targets: ['travelist-monorepo'] }))

    const config = await loadFactoryConfig()

    expect(config.workspaceDir).toBe('~/projects')
    expect(config.targets).toEqual(['travelist-monorepo'])
  })

  it('throws an actionable error when the file is absent', async () => {
    await expect(loadFactoryConfig()).rejects.toThrow(/vendor-config --init/)
  })

  it('throws a descriptive error on malformed JSON', async () => {
    writeConfig('{ not valid json ')
    await expect(loadFactoryConfig()).rejects.toThrow(/Invalid JSON in vendor\.json/)
  })

  it('throws on a schema-invalid config (missing targets)', async () => {
    writeConfig(JSON.stringify({ workspaceDir: '~/projects' }))
    await expect(loadFactoryConfig()).rejects.toThrow(/Invalid factory config/)
  })

  it('rejects a stray `copy` key (.strict())', async () => {
    writeConfig(JSON.stringify({ workspaceDir: '~/projects', targets: ['a'], copy: [] }))
    await expect(loadFactoryConfig()).rejects.toThrow(/Invalid factory config/)
  })

  it('reads the current file on every call so an edit is picked up without a restart', async () => {
    writeConfig(JSON.stringify({ workspaceDir: '~/projects', targets: ['first'] }))
    expect((await loadFactoryConfig()).targets).toEqual(['first'])

    writeConfig(JSON.stringify({ workspaceDir: '~/projects', targets: ['second'] }))
    expect((await loadFactoryConfig()).targets).toEqual(['second'])
  })
})
