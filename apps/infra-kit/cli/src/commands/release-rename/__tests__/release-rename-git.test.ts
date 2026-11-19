import { describe, expect, it } from 'vitest'

import type { ReleaseRenameFixture } from 'src/__tests__/helpers/release-rename-fixture'

import { SPAWN_TEST_TIMEOUT_MS, git, registerCliBundle, renameOk, withFixture } from './rename-spawn'

/**
 * @fileoverview
 * Plan §5 AC 5: origin `<new>` sits at the preflight origin `<old>` tip, a local `<new>` (when a local
 * branch existed) sits at the preflight local sha and tracks `origin/<new>`, and `<old>` is gone locally,
 * on origin and as a remote-tracking ref.
 */

const cliPath = registerCliBundle('release-rename-git-')

const OLD = 'release/v1.2.0'
const NEW = 'release/v1.3.0'

const expectOldGone = (fixture: ReleaseRenameFixture): void => {
  expect(fixture.originSha(OLD)).toBeNull()
  expect(fixture.cloneSha(`refs/heads/${OLD}`)).toBeNull()
  expect(fixture.cloneSha(`refs/remotes/origin/${OLD}`)).toBeNull()
}

const LOCAL_CASES = [
  { name: 'a plain local branch', options: { localBranch: true } },
  { name: 'a branch checked out in the release worktree', options: { worktree: true } },
] as const

describe('release rename: git refs (AC 5)', () => {
  it.each(LOCAL_CASES)(
    'moves origin and $name to <new> at the preflight shas, tracking origin/<new>',
    async ({ options }) => {
      await withFixture(cliPath(), options, async (fixture) => {
        const originOld = fixture.originSha(OLD)
        const localOld = fixture.cloneSha(`refs/heads/${OLD}`)

        expect(localOld).toBe(originOld)

        await renameOk(fixture)

        expect(fixture.originSha(NEW)).toBe(originOld)
        expect(fixture.cloneSha(`refs/heads/${NEW}`)).toBe(localOld)
        expect(fixture.cloneSha(`refs/remotes/origin/${NEW}`)).toBe(originOld)
        expect(git(fixture, fixture.repoDir, ['rev-parse', '--abbrev-ref', `${NEW}@{upstream}`]).trim()).toBe(
          `origin/${NEW}`,
        )
        expectOldGone(fixture)
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )

  it(
    'keeps an unpushed local commit on the renamed local branch',
    async () => {
      await withFixture(cliPath(), { localBranch: true }, async (fixture) => {
        const originOld = fixture.originSha(OLD)

        // `dev` is checked out in the clone, so the commit is made without touching the working tree.
        const tree = git(fixture, fixture.repoDir, ['rev-parse', `${OLD}^{tree}`]).trim()
        const commit = git(fixture, fixture.repoDir, ['commit-tree', tree, '-p', OLD, '-m', 'local only']).trim()

        git(fixture, fixture.repoDir, ['update-ref', `refs/heads/${OLD}`, commit])

        const localOld = fixture.cloneSha(`refs/heads/${OLD}`)

        expect(localOld).not.toBe(originOld)

        await renameOk(fixture)

        expect(fixture.originSha(NEW)).toBe(originOld)
        expect(fixture.cloneSha(`refs/heads/${NEW}`)).toBe(localOld)
        expectOldGone(fixture)
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )

  it(
    'with no local branch, renames origin only and creates no local branch',
    async () => {
      await withFixture(cliPath(), { localBranch: false }, async (fixture) => {
        const originOld = fixture.originSha(OLD)

        await renameOk(fixture)

        expect(fixture.originSha(NEW)).toBe(originOld)
        expect(fixture.cloneSha(`refs/heads/${NEW}`)).toBeNull()
        expectOldGone(fixture)
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
})
