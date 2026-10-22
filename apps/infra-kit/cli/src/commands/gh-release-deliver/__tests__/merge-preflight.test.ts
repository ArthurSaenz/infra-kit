import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { $, cd } from 'zx'

import { OperationError } from 'src/lib/errors/operation-error'

import { assertDeliveryMergesClean } from '../merge-preflight'

/**
 * Real git against a local bare `origin`: the preflight's whole value is how `merge-tree` reads
 * actual histories (exit 1 parsing, squash-shaped merge bases), which a zx mock cannot show.
 */

const BRANCH = 'release/v1.2.5'
const originalCwd = process.cwd()
let root: string

const commit = async (file: string, content: string): Promise<void> => {
  const message = `edit ${file}`

  writeFileSync(file, content)
  await $`git add ${file} && git commit -qm ${message}`
}

const push = async (...branches: string[]): Promise<void> => {
  await $`git push -q origin ${branches}`
}

beforeEach(async () => {
  $.quiet = true
  root = mkdtempSync(path.join(tmpdir(), 'deliver-preflight-'))
  await $`git init -q --bare ${path.join(root, 'origin.git')}`
  await $`git clone -q ${path.join(root, 'origin.git')} ${path.join(root, 'work')}`
  cd(path.join(root, 'work'))
  await $`git config user.email t@t && git config user.name t && git checkout -qb main`
  await commit('a.txt', 'base\n')
  await $`git branch dev`
  await push('main', 'dev')
})

afterEach(() => {
  cd(originalCwd)
  rmSync(root, { recursive: true, force: true })
})

const run = (overrides: Partial<Parameters<typeof assertDeliveryMergesClean>[0]> = {}) => {
  return assertDeliveryMergesClean({
    releaseBranch: BRANCH,
    releaseType: 'regular',
    releaseMerged: false,
    rcMerged: false,
    ...overrides,
  }).catch((e: unknown) => {
    return e
  })
}

describe('assertDeliveryMergesClean — regular', () => {
  it('passes when release → dev → main all merge cleanly', async () => {
    await $`git checkout -qb ${BRANCH} dev`
    await commit('b.txt', 'feature\n')
    await push(BRANCH)

    await expect(run()).resolves.toBeUndefined()
  })

  it('refuses when the release branch conflicts with dev, naming the file', async () => {
    await $`git checkout -qb ${BRANCH} dev`
    await commit('a.txt', 'release\n')
    await $`git checkout -q dev`
    await commit('a.txt', 'dev\n')
    await push(BRANCH, 'dev')

    const error = await run()

    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).message).toContain(`merging ${BRANCH} into dev`)
    expect((error as OperationError).message).toContain('a.txt')
  })

  it('refuses when the squashed release would conflict with a hotfix already on main', async () => {
    await commit('a.txt', 'hotfix\n')
    await $`git checkout -qb ${BRANCH} dev`
    await commit('a.txt', 'release\n')
    await push('main', BRANCH)

    const error = await run()

    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).message).toContain('merging dev into main (RC PR)')
  })

  it('resume after the RC merged: checks only the main → dev sync', async () => {
    await commit('a.txt', 'main\n')
    await $`git checkout -q dev`
    await commit('a.txt', 'dev\n')
    await push('main', 'dev')

    const error = await run({ releaseMerged: true, rcMerged: true })

    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).message).toContain('syncing main back into dev')
  })
})

describe('assertDeliveryMergesClean — hotfix', () => {
  it('passes a hotfix that touches what dev does not', async () => {
    await $`git checkout -qb ${BRANCH} main`
    await commit('fix.txt', 'fix\n')
    await $`git checkout -q dev`
    await commit('a.txt', 'dev\n')
    await push(BRANCH, 'dev')

    await expect(run({ releaseType: 'hotfix' })).resolves.toBeUndefined()
  })

  it('refuses when the squashed hotfix would conflict syncing main into dev', async () => {
    await $`git checkout -qb ${BRANCH} main`
    await commit('a.txt', 'fix\n')
    await $`git checkout -q dev`
    await commit('a.txt', 'dev\n')
    await push(BRANCH, 'dev')

    const error = await run({ releaseType: 'hotfix' })

    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).message).toContain('syncing main back into dev')
    expect((error as OperationError).message).toContain('a.txt')
  })

  it('resume after the hotfix merged and its branch was deleted: no fetch of the gone branch', async () => {
    await expect(run({ releaseType: 'hotfix', releaseMerged: true })).resolves.toBeUndefined()
  })
})
