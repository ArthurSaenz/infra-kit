import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { $ } from 'zx'

import { checkMergeDevResolutions } from '../doctor'

const NOW = Date.parse('2026-09-26T12:00:00Z')

let repo: string

const writeState = async (slug: string, fields: Record<string, unknown>): Promise<void> => {
  const dir = path.join(repo, '.git', 'infra-kit', 'merge-dev-resolutions')

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(fields))
}

beforeEach(async () => {
  repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-merge-dev-')))
  await $({ cwd: repo, quiet: true })`git init -q`
})

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('checkMergeDevResolutions', () => {
  it('skips outside a git repo', async () => {
    expect(await checkMergeDevResolutions(null, NOW)).toMatchObject({ status: 'skip' })
  })

  it('passes when no hand-off is in progress', async () => {
    expect(await checkMergeDevResolutions(repo, NOW)).toMatchObject({
      name: 'merge-dev resolutions',
      status: 'pass',
    })
  })

  it('warns with each unfinished hand-off, its age, and the finishing command', async () => {
    const liveWorktree = path.join(repo, 'wt')

    await fs.mkdir(liveWorktree)
    await writeState('release-v1-2-0', {
      branch: 'release/v1.2.0',
      worktreePath: liveWorktree,
      createdAt: '2026-09-23T10:00:00Z',
    })
    await writeState('release-v1-3-0', {
      branch: 'release/v1.3.0',
      worktreePath: path.join(repo, 'gone'),
      createdAt: '2026-09-26T09:00:00Z',
    })

    const result = await checkMergeDevResolutions(repo, NOW)

    expect(result.status).toBe('warn')
    expect(result.message).toMatch(/^2 unfinished merge-dev hand-offs: /)
    expect(result.message).toContain(`release/v1.2.0 (3d old, ${liveWorktree})`)
    expect(result.message).toContain('release/v1.3.0 (3h old, worktree missing)')
    expect(result.message).toContain('--continue --versions release/v1.2.0,release/v1.3.0')
    expect(result.message).toContain('--abort')
  })
})
