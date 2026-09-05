import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { syncPackageGuidance, syncRootGuidance } from '../agent-guidance'
import { PACKAGE_MARKER_END, PACKAGE_MARKER_START, ROOT_MARKER_START } from '../markers'
import { resetGitStateCache } from '../write-managed-file'

const VERSION = '0.4.0'

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
}

/** A temp repo root holding `packages/lib-a` (or `apps/demo/ui`) with a package.json. */
const makeRepo = (relDir: string, name: string): { root: string; packageDir: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-sync-'))
  const packageDir = path.join(root, relDir)

  writeFile(path.join(packageDir, 'package.json'), `${JSON.stringify({ name }, null, 2)}\n`)

  return { root, packageDir }
}

describe('syncPackageGuidance', () => {
  beforeEach(() => {
    resetGitStateCache()
  })

  it('creates a typed package block, then reports unchanged on a re-run', async () => {
    const { root, packageDir } = makeRepo(path.join('packages', 'lib-a'), '@x/lib-a')

    const first = await syncPackageGuidance(packageDir, { repoRoot: root, version: VERSION })

    expect(first).toEqual([{ path: path.join(packageDir, 'CLAUDE.md'), action: 'created', type: 'lib' }])

    const written = fs.readFileSync(path.join(packageDir, 'CLAUDE.md'), 'utf-8')

    expect(written).toContain(PACKAGE_MARKER_START)
    expect(written).toContain(PACKAGE_MARKER_END)
    expect(written).toContain('@x/lib-a')
    expect(written).toContain('packages/lib-a')
    expect(written).not.toContain(ROOT_MARKER_START)

    const second = await syncPackageGuidance(packageDir, { repoRoot: root, version: VERSION })

    expect(second[0]?.action).toBe('unchanged')
    expect(fs.readFileSync(path.join(packageDir, 'CLAUDE.md'), 'utf-8')).toBe(written)
  })

  it('detects the type from the apps/<app>/ui directory convention', async () => {
    const { root, packageDir } = makeRepo(path.join('apps', 'demo', 'ui'), '@x/demo-ui')

    const [write] = await syncPackageGuidance(packageDir, { repoRoot: root, version: VERSION })

    expect(write?.type).toBe('frontend')
    expect(fs.readFileSync(path.join(packageDir, 'CLAUDE.md'), 'utf-8')).toContain('DESIGN.md')
  })

  it('preserves hand-authored prose above and below the block', async () => {
    const { root, packageDir } = makeRepo(path.join('packages', 'lib-a'), '@x/lib-a')
    const claudePath = path.join(packageDir, 'CLAUDE.md')

    await syncPackageGuidance(packageDir, { repoRoot: root, version: VERSION })

    const generated = fs.readFileSync(claudePath, 'utf-8')

    writeFile(claudePath, `# Hand notes\n\nabove the block\n\n${generated}\nbelow the block\n`)

    const [write] = await syncPackageGuidance(packageDir, { repoRoot: root, version: '0.5.0' })
    const updated = fs.readFileSync(claudePath, 'utf-8')

    expect(write?.action).toBe('updated')
    expect(updated).toContain('# Hand notes')
    expect(updated).toContain('above the block')
    expect(updated).toContain('below the block')
    expect(updated).toContain('0.5.0')
    expect(updated.match(new RegExp(PACKAGE_MARKER_START, 'g'))).toHaveLength(1)
  })

  it('scaffolds DESIGN.md only with design:true, only for a visual type, and never overwrites', async () => {
    const ui = makeRepo(path.join('apps', 'demo', 'ui'), '@x/demo-ui')
    const lib = makeRepo(path.join('packages', 'lib-a'), '@x/lib-a')

    await syncPackageGuidance(lib.packageDir, { repoRoot: lib.root, version: VERSION, design: true })
    expect(fs.existsSync(path.join(lib.packageDir, 'DESIGN.md'))).toBe(false)

    const created = await syncPackageGuidance(ui.packageDir, { repoRoot: ui.root, version: VERSION, design: true })

    expect(created).toHaveLength(2)
    expect(created[1]).toMatchObject({ path: path.join(ui.packageDir, 'DESIGN.md'), action: 'created' })

    const designPath = path.join(ui.packageDir, 'DESIGN.md')

    fs.writeFileSync(designPath, 'hand-authored design\n', 'utf-8')

    const again = await syncPackageGuidance(ui.packageDir, { repoRoot: ui.root, version: VERSION, design: true })

    expect(again).toHaveLength(1)
    expect(fs.readFileSync(designPath, 'utf-8')).toBe('hand-authored design\n')
  })

  it('honours a declared type over the directory convention', async () => {
    const { root, packageDir } = makeRepo(path.join('apps', 'demo', 'ui'), '@x/demo-ui')

    const [write] = await syncPackageGuidance(packageDir, {
      repoRoot: root,
      version: VERSION,
      declaredType: 'backend',
    })

    expect(write?.type).toBe('backend')
  })

  it('reports a per-file error as action failed instead of throwing', async () => {
    const { root, packageDir } = makeRepo(path.join('packages', 'lib-a'), '@x/lib-a')
    const claudePath = path.join(packageDir, 'CLAUDE.md')

    // A DANGLING symlink: `existsSync` says false, so only the hardened lstat gate catches it.
    fs.symlinkSync(path.join(packageDir, 'nowhere.md'), claudePath)

    const [write] = await syncPackageGuidance(packageDir, { repoRoot: root, version: VERSION })

    expect(write?.action).toBe('failed')
    expect(write?.type).toBe('lib')
    expect(write?.message).toMatch(/symlink/)
    expect(fs.existsSync(path.join(packageDir, 'nowhere.md'))).toBe(false)
  })
})

describe('syncRootGuidance', () => {
  beforeEach(() => {
    resetGitStateCache()
  })

  it('writes the root block and reports a failed root file rather than throwing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-sync-root-'))

    const written = await syncRootGuidance(root, { version: VERSION })

    expect(written[0]).toEqual({ path: path.join(root, 'CLAUDE.md'), action: 'created' })
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8')).toContain(ROOT_MARKER_START)

    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-sync-root-'))

    fs.symlinkSync(path.join(broken, 'nowhere.md'), path.join(broken, 'CLAUDE.md'))

    const failed = await syncRootGuidance(broken, { version: VERSION })

    expect(failed[0]).toMatchObject({ action: 'failed' })
    expect(failed[0]?.message).toMatch(/symlink/)
  })
})
