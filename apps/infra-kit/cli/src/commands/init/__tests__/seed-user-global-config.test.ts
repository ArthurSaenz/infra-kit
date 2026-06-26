import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedUserGlobalConfig } from '../init'

let home: string
let dir: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-user-global-test-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  dir = path.join(home, '.infra-kit')
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('seedUserGlobalConfig', () => {
  it('seeds the infra-kit.json stub and both fully-commented example files', () => {
    seedUserGlobalConfig()

    expect(fs.readFileSync(path.join(dir, 'infra-kit.json'), 'utf-8')).toBe('{}\n')

    const infraExample = fs.readFileSync(path.join(dir, 'infra-kit.example.jsonc'), 'utf-8')

    // Every recognized infra-kit property is documented.
    for (const key of ['environments', 'envManagement', 'ide', 'taskManager', 'worktrees']) {
      expect(infraExample).toContain(key)
    }

    const vendorExample = fs.readFileSync(path.join(dir, 'vendor.example.jsonc'), 'utf-8')

    expect(vendorExample).toContain('workspaceDir')
    expect(vendorExample).toContain('targets')
  })

  it('never seeds a real vendor.json (only the example)', () => {
    seedUserGlobalConfig()

    expect(fs.existsSync(path.join(dir, 'vendor.example.jsonc'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'vendor.json'))).toBe(false)
  })

  it('refreshes the example files on a re-run while leaving an existing infra-kit.json byte-unchanged', () => {
    fs.mkdirSync(dir, { recursive: true })
    const realConfig = '{ "environments": ["dev"] }\n'

    fs.writeFileSync(path.join(dir, 'infra-kit.json'), realConfig)
    // Stale example a previous version might have written.
    fs.writeFileSync(path.join(dir, 'infra-kit.example.jsonc'), '// stale\n')

    seedUserGlobalConfig()

    // Real config preserved exactly…
    expect(fs.readFileSync(path.join(dir, 'infra-kit.json'), 'utf-8')).toBe(realConfig)
    // …examples refreshed to the current template (no longer "stale").
    expect(fs.readFileSync(path.join(dir, 'infra-kit.example.jsonc'), 'utf-8')).not.toBe('// stale\n')
    expect(fs.existsSync(path.join(dir, 'vendor.example.jsonc'))).toBe(true)
  })
})
