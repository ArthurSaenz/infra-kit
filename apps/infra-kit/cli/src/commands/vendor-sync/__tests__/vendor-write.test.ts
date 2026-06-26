import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { execMock, zxModuleMock } from 'src/lib/vendor/__tests__/zx-mock'

import { vendorSync } from '../vendor-sync'

// Mock zx so the write commands run without shelling out to rsync/cp/git.
vi.mock('zx', () => {
  return zxModuleMock()
})

let parent: string
let home: string
let sourceRoot: string
let targetRoot: string

const write = (root: string, rel: string, content: string): void => {
  const full = path.join(root, rel)

  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

beforeEach(() => {
  vi.clearAllMocks()
  execMock.mockResolvedValue({ stdout: 'deadbeef\n' })

  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-write-test-'))
  sourceRoot = path.join(parent, 'source-repo')
  targetRoot = path.join(parent, 'target-repo')

  // Machine-local factory config (workspaceDir + targets) lives under ~/.infra-kit;
  // point os.homedir() at a fixture so the loader finds it.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-write-home-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  write(home, '.infra-kit/vendor.json', JSON.stringify({ workspaceDir: parent, targets: ['target-repo'] }))

  // Source repo: vendor content + config (copy[] only — targets is machine-local now).
  write(sourceRoot, 'vendor/configs/a.js', 'aaa')
  write(
    sourceRoot,
    'vendor.config.ts',
    `export default { copy: [{ name: 'Configs', source: 'vendor/configs', target: 'vendor/configs', type: 'directory', vendored: true }] }`,
  )

  // Target repo: pre-existing vendor content (rsync is mocked, so this stays).
  write(targetRoot, 'vendor/configs/a.js', 'aaa')
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(parent, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

describe('vendorSync', () => {
  it('writes a manifest + README into the target vendor/ tree', async () => {
    const { structuredContent } = await vendorSync({ cwd: sourceRoot, confirmedCommand: true })

    expect(structuredContent.source).toBe('source-repo')
    expect(structuredContent.repos).toHaveLength(1)
    expect(structuredContent.repos[0]?.skipped).toBe(false)

    const manifestPath = path.join(targetRoot, 'vendor', '.sync-manifest.json')
    const readmePath = path.join(targetRoot, 'vendor', 'README.md')

    expect(fs.existsSync(manifestPath)).toBe(true)
    expect(fs.existsSync(readmePath)).toBe(true)

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

    expect(manifest.schemaVersion).toBe(1)
    expect(Object.keys(manifest.files)).toContain('configs/a.js')
  })

  it('marks a non-existent target as skipped', async () => {
    fs.rmSync(targetRoot, { recursive: true, force: true })

    const { structuredContent } = await vendorSync({ cwd: sourceRoot, confirmedCommand: true })

    expect(structuredContent.repos[0]?.skipped).toBe(true)
  })
})
