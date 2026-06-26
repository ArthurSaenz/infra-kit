import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from 'src/lib/logger'

import { migrateFactoryConfigToJson } from '../migrate-config'

let home: string
let dir: string
let oldTs: string
let newJson: string
let infoSpy: ReturnType<typeof vi.spyOn>

const messages = (): string => {
  return infoSpy.mock.calls
    .map((c: unknown[]) => {
      return String(c[0])
    })
    .join('\n')
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-factory-test-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  dir = path.join(home, '.infra-kit')
  oldTs = path.join(dir, 'vendor.config.ts')
  newJson = path.join(dir, 'vendor.json')
  fs.mkdirSync(dir, { recursive: true })
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('migrateFactoryConfigToJson', () => {
  it('converts an object-form vendor.config.ts to vendor.json and removes the .ts (plain ✓, no warning)', async () => {
    fs.writeFileSync(oldTs, `export default { workspaceDir: '~/projects', targets: ['repo-a'] }`)

    await migrateFactoryConfigToJson()

    expect(fs.existsSync(oldTs)).toBe(false)
    expect(JSON.parse(fs.readFileSync(newJson, 'utf-8'))).toEqual({ workspaceDir: '~/projects', targets: ['repo-a'] })
    expect(messages()).toMatch(/✓ Migrated/)
    expect(messages()).not.toMatch(/STATIC SNAPSHOT/)
  })

  it('converts a factory-function form AND emits the STATIC SNAPSHOT warning (not a plain ✓)', async () => {
    fs.writeFileSync(oldTs, `export default () => ({ workspaceDir: '/abs/repos', targets: ['repo-b'] })`)

    await migrateFactoryConfigToJson()

    expect(fs.existsSync(oldTs)).toBe(false)
    expect(JSON.parse(fs.readFileSync(newJson, 'utf-8'))).toEqual({ workspaceDir: '/abs/repos', targets: ['repo-b'] })
    expect(messages()).toMatch(/STATIC SNAPSHOT/)
    expect(messages()).not.toMatch(/✓ Migrated/)
  })

  it('is a no-op when there is no legacy vendor.config.ts (idempotent)', async () => {
    await migrateFactoryConfigToJson()

    expect(fs.existsSync(newJson)).toBe(false)
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it('never overwrites an existing vendor.json; leaves the .ts in place and warns', async () => {
    const existing = { workspaceDir: '~/active', targets: ['keep-me'] }

    fs.writeFileSync(oldTs, `export default { workspaceDir: '~/stale', targets: ['old'] }`)
    fs.writeFileSync(newJson, JSON.stringify(existing))

    await migrateFactoryConfigToJson()

    // Active vendor.json untouched; the stale .ts is preserved (not deleted).
    expect(JSON.parse(fs.readFileSync(newJson, 'utf-8'))).toEqual(existing)
    expect(fs.existsSync(oldTs)).toBe(true)
    expect(messages()).toMatch(/already exists/)
  })

  it('leaves an invalid old .ts in place (non-fatal) and writes no vendor.json', async () => {
    // Missing required `targets` → fails factoryConfigSchema.
    fs.writeFileSync(oldTs, `export default { workspaceDir: '~/projects' }`)

    await expect(migrateFactoryConfigToJson()).resolves.toBeUndefined()

    expect(fs.existsSync(oldTs)).toBe(true)
    expect(fs.existsSync(newJson)).toBe(false)
    expect(messages()).toMatch(/invalid factory config/)
  })
})
