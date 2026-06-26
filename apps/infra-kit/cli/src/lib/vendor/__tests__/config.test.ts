import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defineVendorConfig, loadVendorConfig } from '../config'

let root: string

const writeConfig = (body: string): void => {
  fs.writeFileSync(path.join(root, 'vendor.config.ts'), body, 'utf8')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-config-test-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('defineVendorConfig', () => {
  it('is an identity helper', () => {
    const config = { copy: [] }

    expect(defineVendorConfig(config)).toBe(config)
  })
})

describe('loadVendorConfig', () => {
  it('loads an object default export', async () => {
    writeConfig(
      `export default { copy: [{ name: 'Configs', source: 'vendor/configs', target: 'vendor/configs', type: 'directory', vendored: true }] }`,
    )

    const config = await loadVendorConfig(root)

    expect(config.copy[0]?.name).toBe('Configs')
    expect(config.copy[0]?.vendored).toBe(true)
  })

  it('loads a factory (function) default export', async () => {
    writeConfig(`export default () => ({ copy: [] })`)

    const config = await loadVendorConfig(root)

    expect(config.copy).toEqual([])
  })

  it('throws on a missing config file', async () => {
    await expect(loadVendorConfig(root)).rejects.toThrow(/vendor\.config\.ts not found/)
  })

  it('throws on a schema-invalid config', async () => {
    writeConfig(`export default { copy: 'not-an-array' }`)
    await expect(loadVendorConfig(root)).rejects.toThrow(/Invalid vendor\.config\.ts/)
  })

  it('rejects a stray `targets` key (now machine-local, not in the source config)', async () => {
    writeConfig(`export default { targets: ['travelist-monorepo'], copy: [] }`)
    await expect(loadVendorConfig(root)).rejects.toThrow(/Invalid vendor\.config\.ts/)
  })
})
