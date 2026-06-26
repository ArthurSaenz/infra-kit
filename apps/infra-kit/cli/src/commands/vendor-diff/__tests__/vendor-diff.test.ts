import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { execMock, zxModuleMock } from 'src/lib/vendor/__tests__/zx-mock'

import { vendorDiff } from '../vendor-diff'

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

  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-diff-test-'))
  sourceRoot = path.join(parent, 'source-repo')
  targetRoot = path.join(parent, 'target-repo')

  // Machine-local factory config (workspaceDir + targets) lives under ~/.infra-kit;
  // point os.homedir() at a fixture so the loader finds it.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-diff-home-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  write(home, '.infra-kit/vendor.json', JSON.stringify({ workspaceDir: parent, targets: ['target-repo'] }))

  write(sourceRoot, 'vendor/configs/a.js', 'aaa')
  write(
    sourceRoot,
    'vendor.config.ts',
    `export default { copy: [{ name: 'Configs', source: 'vendor/configs', target: 'vendor/configs', type: 'directory', vendored: true }] }`,
  )
  write(targetRoot, 'vendor/configs/a.js', 'DIFFERENT')
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(parent, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

describe('vendorDiff', () => {
  it('reports drift when rsync dry-run returns changes', async () => {
    execMock.mockResolvedValue({ stdout: '>f.st..... configs/a.js\n' })

    const { structuredContent } = await vendorDiff({ cwd: sourceRoot })

    expect(structuredContent.ok).toBe(false)
    expect(structuredContent.drifted).toBe(1)
    expect(structuredContent.entries[0]?.repo).toBe('target-repo')
    expect(structuredContent.entries[0]?.changes).toContain('>f.st..... configs/a.js')
  })

  it('reports no drift when rsync dry-run is empty', async () => {
    execMock.mockResolvedValue({ stdout: '' })

    const { structuredContent } = await vendorDiff({ cwd: sourceRoot })

    expect(structuredContent.ok).toBe(true)
    expect(structuredContent.drifted).toBe(0)
  })
})
