import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getMainRepoRoot } from 'src/lib/git-utils'

import { discoverInfraKitProjects } from '../project-discovery'

// discoverInfraKitProjects consults ONLY getMainRepoRoot from git-utils (the
// fallback rung). Everything else is real fs against a temp workspace.
vi.mock('src/lib/git-utils', () => {
  return {
    getMainRepoRoot: vi.fn(),
  }
})

/** Create a live-looking project dir: `<root>/<name>` with a `.git` + `infra-kit.json`. */
const mkProject = (
  root: string,
  name: string,
  opts: { git?: boolean; gitAsDir?: boolean; config?: boolean } = {},
): string => {
  const { git = true, gitAsDir = false, config = true } = opts
  const dir = path.join(root, name)

  fs.mkdirSync(dir, { recursive: true })

  if (git) {
    if (gitAsDir) fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    else fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /somewhere\n')
  }

  if (config) fs.writeFileSync(path.join(dir, 'infra-kit.json'), '{}\n')

  return dir
}

describe('discoverInfraKitProjects', () => {
  let workspace: string

  beforeEach(() => {
    vi.clearAllMocks()
    // realpath the base so /var → /private/var aliasing doesn't skew equality.
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-discovery-')))
  })

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it('uses explicit roots verbatim and never consults getMainRepoRoot', async () => {
    mkProject(workspace, 'bravo')
    mkProject(workspace, 'alpha')
    vi.mocked(getMainRepoRoot).mockRejectedValue(new Error('should not be called'))

    const found = await discoverInfraKitProjects({ roots: [workspace] })

    expect(
      found.map((project) => {
        return project.name
      }),
    ).toEqual(['alpha', 'bravo'])
    expect(getMainRepoRoot).not.toHaveBeenCalled()
  })

  it('falls back to dirname(getMainRepoRoot()) when no roots are given', async () => {
    mkProject(workspace, 'hulyo-monorepo')
    // getMainRepoRoot points at a repo INSIDE the workspace; its dirname is the workspace.
    vi.mocked(getMainRepoRoot).mockResolvedValue(path.join(workspace, 'hulyo-monorepo'))

    const found = await discoverInfraKitProjects()

    expect(
      found.map((project) => {
        return project.name
      }),
    ).toEqual(['hulyo-monorepo'])
  })

  it('throws an OperationError with remediation outside a git repo and no roots', async () => {
    vi.mocked(getMainRepoRoot).mockRejectedValue(new Error('not a git repository'))

    await expect(discoverInfraKitProjects()).rejects.toThrow(/run inside an infra-kit repo, or pass --root/)
  })

  it('scans depth 1 only — a repo two levels down is NOT found', async () => {
    // <workspace>/nested/deep-repo is live, but `nested` itself is not a project.
    mkProject(path.join(workspace, 'nested'), 'deep-repo')

    const found = await discoverInfraKitProjects({ roots: [workspace] })

    expect(found).toEqual([])
  })

  it('excludes a candidate with .git but no infra-kit.json, and vice versa', async () => {
    mkProject(workspace, 'git-no-config', { config: false })
    mkProject(workspace, 'config-no-git', { git: false })
    mkProject(workspace, 'live', { gitAsDir: true })

    const found = await discoverInfraKitProjects({ roots: [workspace] })

    expect(
      found.map((project) => {
        return project.name
      }),
    ).toEqual(['live'])
  })

  it('dedupes by realpath — two candidates resolving to the same dir collapse to one', async () => {
    const real = mkProject(workspace, 'real-repo')

    fs.symlinkSync(real, path.join(workspace, 'aliased-repo'))

    const found = await discoverInfraKitProjects({ roots: [workspace] })

    expect(found).toHaveLength(1)
    expect(found[0]?.repoRoot).toBe(fs.realpathSync(real))
  })

  it('never surfaces a registered-but-absent project (strict-test shape)', async () => {
    // Only `infra-kit` exists on disk; `strict-test` is registered elsewhere but has no dir here.
    mkProject(workspace, 'infra-kit')

    const found = await discoverInfraKitProjects({ roots: [workspace] })

    expect(
      found.map((project) => {
        return project.name
      }),
    ).toEqual(['infra-kit'])
    expect(
      found.some((project) => {
        return project.name === 'strict-test'
      }),
    ).toBe(false)
  })
})
