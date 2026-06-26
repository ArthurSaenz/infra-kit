import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeManifest } from 'src/lib/vendor'
import { execMock, zxModuleMock } from 'src/lib/vendor/__tests__/zx-mock'

import { vendorCheck } from '../vendor-check'

// Spy on every subprocess-spawning and config-loading collaborator. The
// invariant under test is RUNTIME: invoking `vendor check` must spawn zero
// subprocess and load zero vendor.config.ts — regardless of what the single
// bundled CLI artifact happens to contain.
vi.mock('zx', () => {
  return zxModuleMock()
})

const loadVendorConfigMock = vi.fn()

vi.mock('src/lib/vendor/config', async (importActual) => {
  const actual = await importActual<typeof import('src/lib/vendor/config')>()

  return { ...actual, loadVendorConfig: loadVendorConfigMock }
})

const loadFactoryConfigMock = vi.fn()

vi.mock('src/lib/vendor/factory-config', async (importActual) => {
  const actual = await importActual<typeof import('src/lib/vendor/factory-config')>()

  return { ...actual, loadFactoryConfig: loadFactoryConfigMock }
})

let root: string
let vendorRoot: string

beforeEach(() => {
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-isolation-test-'))
  vendorRoot = path.join(root, 'vendor')
  fs.mkdirSync(path.join(vendorRoot, 'configs'), { recursive: true })
  fs.writeFileSync(path.join(vendorRoot, 'configs', 'a.js'), 'aaa')
  writeManifest(vendorRoot, { source: 's', commit: 'c' })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('vendor check runtime isolation', () => {
  it('spawns no subprocess and loads no vendor.config.ts on a clean check', async () => {
    const { structuredContent } = await vendorCheck({ cwd: root })

    expect(structuredContent.ok).toBe(true)
    expect(execMock).not.toHaveBeenCalled()
    expect(loadVendorConfigMock).not.toHaveBeenCalled()
    expect(loadFactoryConfigMock).not.toHaveBeenCalled()
  })

  it('spawns no subprocess even when reporting drift', async () => {
    fs.writeFileSync(path.join(vendorRoot, 'configs', 'a.js'), 'CHANGED')

    const { structuredContent } = await vendorCheck({ cwd: root })

    expect(structuredContent.ok).toBe(false)
    expect(execMock).not.toHaveBeenCalled()
    expect(loadVendorConfigMock).not.toHaveBeenCalled()
    expect(loadFactoryConfigMock).not.toHaveBeenCalled()
  })
})
