import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getFactoryConfigPath } from 'src/lib/vendor/factory-config'

import { vendorConfig } from '../vendor-config'

let home: string
let source: string
let factoryPath: string

const writeFactory = (workspaceDir: string, targets: string[]): void => {
  fs.mkdirSync(path.dirname(factoryPath), { recursive: true })
  fs.writeFileSync(factoryPath, JSON.stringify({ workspaceDir, targets }), 'utf8')
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-config-home-'))
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-config-src-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  factoryPath = getFactoryConfigPath()
  process.exitCode = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(source, { recursive: true, force: true })
  process.exitCode = 0
})

describe('vendorConfig (print)', () => {
  it('exits non-zero when the factory config is absent', async () => {
    await vendorConfig()

    expect(process.exitCode).toBe(1)
  })

  it('exits zero when workspaceDir and every target are reachable', async () => {
    const workspaceDir = path.join(home, 'projects')

    fs.mkdirSync(path.join(workspaceDir, 'repo-a'), { recursive: true })
    writeFactory(workspaceDir, ['repo-a'])

    await vendorConfig()

    expect(process.exitCode).toBe(0)
  })

  it('exits non-zero when a target is missing', async () => {
    const workspaceDir = path.join(home, 'projects')

    fs.mkdirSync(workspaceDir, { recursive: true })
    writeFactory(workspaceDir, ['missing-repo'])

    await vendorConfig()

    expect(process.exitCode).toBe(1)
  })
})

describe('vendorConfig --init', () => {
  it('scaffolds the factory config as strict JSON with a placeholder workspaceDir', async () => {
    await vendorConfig({ init: true, cwd: source })

    const written = fs.readFileSync(factoryPath, 'utf8')
    const parsed = JSON.parse(written)

    // Strict JSON — no executable export, no `infra-kit` import.
    expect(written).not.toContain('export default')
    expect(written).not.toContain(`from 'infra-kit'`)
    expect(parsed.workspaceDir).toBe('~/projects')
  })

  it('seeds targets from a legacy source vendor.config.ts', async () => {
    // The SOURCE config stays TypeScript (only the machine-local factory file moved to JSON).
    fs.writeFileSync(
      path.join(source, 'vendor.config.ts'),
      `export default { targets: ['travelist-monorepo', 'hulyo-monorepo'], copy: [] }`,
      'utf8',
    )

    await vendorConfig({ init: true, cwd: source })

    const parsed = JSON.parse(fs.readFileSync(factoryPath, 'utf8'))

    expect(parsed.targets).toEqual(['travelist-monorepo', 'hulyo-monorepo'])
  })

  it('leaves an existing factory config untouched', async () => {
    const workspaceDir = path.join(home, 'projects')

    writeFactory(workspaceDir, ['original-repo'])
    const before = fs.readFileSync(factoryPath, 'utf8')

    await vendorConfig({ init: true, cwd: source })

    expect(fs.readFileSync(factoryPath, 'utf8')).toBe(before)
  })
})
