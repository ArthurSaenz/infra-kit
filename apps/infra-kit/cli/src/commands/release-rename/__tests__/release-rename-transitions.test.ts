import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { ReleaseRenameFixture } from 'src/__tests__/helpers/release-rename-fixture'
import { formatJiraName, formatPrTitle, parseReleaseRef } from 'src/lib/release-id'

import {
  SPAWN_TEST_TIMEOUT_MS,
  expectNothingMutated,
  git,
  openPrsOn,
  output,
  registerCliBundle,
  runRename,
  snapshot,
  withFixture,
} from './rename-spawn'

/**
 * @fileoverview
 * Plan §4 Step 5 `release-rename-transitions`: every kind of name change through the spawned CLI, each
 * checked on the four places a name lives (origin branch, PR title, Jira name, worktree path). Also the
 * "run twice" case of AC 9: a converged rename is a no-op on the second identical run.
 */

const cliPath = registerCliBundle('release-rename-transitions-')

const expectRenamed = (fixture: ReleaseRenameFixture, oldSuffix: string, newRef: string): void => {
  const newId = parseReleaseRef(newRef)
  const newSuffix = newId.kind === 'version' ? `v${newId.raw}` : newId.raw
  const newBranch = `release/${newSuffix}`

  expect(fixture.originSha(newBranch)).not.toBeNull()
  expect(fixture.originSha(`release/${oldSuffix}`)).toBeNull()

  const [newPr, ...extra] = openPrsOn(fixture, [newBranch])

  expect(extra).toStrictEqual([])
  expect(newPr?.title).toBe(formatPrTitle(newId, fixture.type))
  expect(
    fixture.jiraVersions().find((version) => {
      return version.id === fixture.jiraVersionId
    })?.name,
  ).toBe(formatJiraName(newId))
  expect(existsSync(fixture.worktreePathFor(newSuffix))).toBe(true)
  expect(existsSync(fixture.worktreePathFor(oldSuffix))).toBe(false)
  expect(git(fixture, fixture.worktreePathFor(newSuffix), ['branch', '--show-current']).trim()).toBe(newBranch)
}

const TRANSITIONS = [
  { name: 'version → version', release: 'v1.2.0', newRef: '1.3.0', type: 'regular' },
  { name: 'name → name', release: 'checkout-redesign', newRef: 'checkout-v2', type: 'regular' },
  { name: 'name → version', release: 'checkout-redesign', newRef: '1.4.0', type: 'hotfix' },
  { name: 'version → name', release: 'v1.2.0', newRef: 'payments-revamp', type: 'regular' },
] as const

describe('release rename: transitions', () => {
  it.each(TRANSITIONS)(
    '$name renames the branch, PR title, Jira name and worktree path',
    async ({ release, newRef, type }) => {
      await withFixture(cliPath(), { release, type, worktree: true }, async (fixture) => {
        const oldRef = release.startsWith('v') ? release.slice(1) : release
        const run = await runRename(fixture, [oldRef, newRef], { yes: true })

        expect(run.code, output(run)).toBe(0)
        expect(run.json?.outcome, output(run)).toBe('renamed')
        expectRenamed(fixture, release, newRef)
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )

  it(
    'a second identical --yes run after success is a no-op that says "already renamed" and prints the follow-ups',
    async () => {
      await withFixture(cliPath(), { worktree: true }, async (fixture) => {
        const first = await runRename(fixture, ['1.2.0', '1.3.0'], { yes: true })

        expect(first.code, output(first)).toBe(0)

        const before = snapshot(fixture)
        const second = await runRename(fixture, ['1.2.0', '1.3.0'], { yes: true })

        expect(second.code, output(second)).toBe(0)
        expect(second.json).toMatchObject({ outcome: 'already-renamed', renamedSteps: [] })
        expectNothingMutated(fixture, before)

        const followUps = (second.json?.followUps ?? []) as { command: string }[]

        expect(
          followUps.map((followUp) => {
            return followUp.command
          }),
        ).toContain('git fetch --prune && git branch -m release/v1.2.0 release/v1.3.0')

        const human = await runRename(fixture, ['1.2.0', '1.3.0'], { yes: true, json: false })

        expect(human.code, output(human)).toBe(0)
        expect(human.stderr, output(human)).toContain('already renamed')
        expect(human.stderr).toContain('git fetch --prune && git branch -m release/v1.2.0 release/v1.3.0')
        expectNothingMutated(fixture, before)
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
})
