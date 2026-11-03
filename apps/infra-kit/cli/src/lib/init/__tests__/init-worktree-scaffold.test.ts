import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { $ } from 'zx'

import { syncWorktreeScaffold } from '../init'

/**
 * `initCore`'s worktree-scaffold step (US-002): idempotently lays out
 * `<mainRepoRoot>-worktrees/{release,feature,merge-dev}` so `worktrees add`, `worktrees sync` and
 * `gh merge-dev`'s scratch checkout never race their own `mkdir -p` against a first run.
 *
 * Driven against a REAL git repo, not a mocked `getMainRepoRoot`: the function shells out to
 * `git rev-parse --git-common-dir`, and a mock would only prove the parser can read a string this
 * test typed. `getMainRepoRoot` takes `cwd` as an explicit argument rather than reading
 * `process.cwd()`, so no `process.chdir()`/`$.cwd` juggling is needed here.
 */

let repo: string

const worktreeDir = (): string => {
  return `${repo}-worktrees`
}

beforeEach(async () => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'init-worktree-scaffold-')))
  await $({ cwd: repo, quiet: true })`git init --quiet`
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(worktreeDir(), { recursive: true, force: true })
})

describe('syncWorktreeScaffold — creation', () => {
  it('creates release/feature/merge-dev under <mainRepoRoot>-worktrees on a first run', async () => {
    const entries = await syncWorktreeScaffold(repo)

    expect(fs.existsSync(path.join(worktreeDir(), 'release'))).toBe(true)
    expect(fs.existsSync(path.join(worktreeDir(), 'feature'))).toBe(true)
    expect(fs.existsSync(path.join(worktreeDir(), 'merge-dev'))).toBe(true)

    expect(entries).toEqual([
      {
        step: 'worktrees',
        outcome: 'written',
        message: `Created worktree directories at ${worktreeDir()} (release, feature, merge-dev)`,
        level: 'info',
      },
    ])
  })

  it('creates only the missing subdirectory and names just that one', async () => {
    fs.mkdirSync(path.join(worktreeDir(), 'release'), { recursive: true })

    const entries = await syncWorktreeScaffold(repo)

    expect(fs.existsSync(path.join(worktreeDir(), 'feature'))).toBe(true)
    expect(fs.existsSync(path.join(worktreeDir(), 'merge-dev'))).toBe(true)
    expect(entries).toEqual([
      {
        step: 'worktrees',
        outcome: 'written',
        message: `Created worktree directories at ${worktreeDir()} (feature, merge-dev)`,
        level: 'info',
      },
    ])
  })
})

describe('syncWorktreeScaffold — idempotency', () => {
  it('reports unchanged and creates nothing new on a second run', async () => {
    await syncWorktreeScaffold(repo)
    const before = fs.readdirSync(worktreeDir()).sort()

    const entries = await syncWorktreeScaffold(repo)

    expect(fs.readdirSync(worktreeDir()).sort()).toEqual(before)
    expect(entries).toEqual([
      {
        step: 'worktrees',
        outcome: 'unchanged',
        message: `Worktree directories already present at ${worktreeDir()}`,
        level: 'info',
      },
    ])
  })

  it('leaves an existing subdirectory untouched (no re-create) across runs', async () => {
    await syncWorktreeScaffold(repo)
    const releaseDir = path.join(worktreeDir(), 'release')
    const before = fs.statSync(releaseDir).ino

    await syncWorktreeScaffold(repo)

    expect(fs.statSync(releaseDir).ino).toBe(before)
  })
})

describe('syncWorktreeScaffold — no-op outside a repo', () => {
  it('contributes nothing when gitRoot is null (the shared gate already refused and announced)', async () => {
    const entries = await syncWorktreeScaffold(null)

    expect(entries).toEqual([])
    // Nothing computed, nothing written — not even beside the fixture repo made for the other cases.
    expect(fs.existsSync(worktreeDir())).toBe(false)
  })
})
