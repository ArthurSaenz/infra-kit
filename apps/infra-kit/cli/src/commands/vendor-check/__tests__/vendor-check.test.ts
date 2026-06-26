import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeManifest } from 'src/lib/vendor'

import { vendorCheck } from '../vendor-check'

let root: string
let vendorRoot: string

const writeVendor = (rel: string, content: string): void => {
  const full = path.join(vendorRoot, rel)

  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-check-test-'))
  vendorRoot = path.join(root, 'vendor')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('vendorCheck exit-code matrix', () => {
  it('missing vendor/ → ok (skip)', async () => {
    const { structuredContent } = await vendorCheck({ cwd: root })

    expect(structuredContent.status).toBe('skipped')
    expect(structuredContent.ok).toBe(true)
  })

  it('missing manifest → not ok', async () => {
    writeVendor('a.js', 'a')
    const { structuredContent } = await vendorCheck({ cwd: root })

    expect(structuredContent.status).toBe('missing-manifest')
    expect(structuredContent.ok).toBe(false)
  })

  it('clean tree → ok', async () => {
    writeVendor('configs/a.js', 'a')
    writeVendor('packages/p/b.ts', 'b')
    writeManifest(vendorRoot, { source: 's', commit: 'c' })

    const { structuredContent } = await vendorCheck({ cwd: root })

    expect(structuredContent.status).toBe('clean')
    expect(structuredContent.ok).toBe(true)
    expect(structuredContent.fileCount).toBe(2)
  })

  it('drifted tree → not ok with categorized paths', async () => {
    writeVendor('a.js', 'a')
    writeVendor('b.js', 'b')
    writeManifest(vendorRoot, { source: 's', commit: 'c' })

    fs.writeFileSync(path.join(vendorRoot, 'a.js'), 'CHANGED')
    writeVendor('c.js', 'c')
    fs.rmSync(path.join(vendorRoot, 'b.js'))

    const { structuredContent } = await vendorCheck({ cwd: root })

    expect(structuredContent.status).toBe('drift')
    expect(structuredContent.ok).toBe(false)
    expect(structuredContent.modified).toEqual(['a.js'])
    expect(structuredContent.added).toEqual(['c.js'])
    expect(structuredContent.removed).toEqual(['b.js'])
  })

  it('unknown future schemaVersion → not ok (fail-closed)', async () => {
    writeVendor('a.js', 'a')
    const manifest = writeManifest(vendorRoot, { source: 's', commit: 'c' })
    const bumped = { ...manifest, schemaVersion: (manifest.schemaVersion ?? 1) + 1 }

    fs.writeFileSync(path.join(vendorRoot, '.sync-manifest.json'), JSON.stringify(bumped))

    const { structuredContent } = await vendorCheck({ cwd: root })

    expect(structuredContent.status).toBe('unknown-schema')
    expect(structuredContent.ok).toBe(false)
  })
})
