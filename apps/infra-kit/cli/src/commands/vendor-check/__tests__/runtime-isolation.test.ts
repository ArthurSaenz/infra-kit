import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeManifest } from 'src/lib/vendor'
import { execMock, zxModuleMock } from 'src/lib/vendor/__tests__/zx-mock'

import { vendorCheck } from '../vendor-check'

// The invariant under test is RUNTIME: invoking `vendor check` must spawn zero
// subprocess — regardless of what the single bundled CLI artifact happens to
// contain. `vendor-check.ts` imports ONLY the read-path barrel (`src/lib/vendor`),
// never the config loader or rsync/`zx` write path, so this stays true by
// construction; the `zx` spy is the guard that a future edit does not smuggle a
// subprocess back onto the check path.
vi.mock('zx', () => {
  return zxModuleMock()
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
  it('spawns no subprocess on a clean check', async () => {
    const { structuredContent } = await vendorCheck({ cwd: root })

    expect(structuredContent.ok).toBe(true)
    expect(execMock).not.toHaveBeenCalled()
  })

  it('spawns no subprocess even when reporting drift', async () => {
    fs.writeFileSync(path.join(vendorRoot, 'configs', 'a.js'), 'CHANGED')

    const { structuredContent } = await vendorCheck({ cwd: root })

    expect(structuredContent.ok).toBe(false)
    expect(execMock).not.toHaveBeenCalled()
  })
})
