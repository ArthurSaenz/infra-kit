import { describe, expect, it } from 'vitest'

import {
  SPAWN_TEST_TIMEOUT_MS,
  addChildPr,
  expectNothingMutated,
  output,
  registerCliBundle,
  runRename,
  snapshot,
  withFixture,
} from './rename-spawn'

/**
 * @fileoverview
 * Plan §5 AC 1 and AC 2 through the spawned CLI: without `--yes` the command previews every place
 * `old → new` with its state and exits 2 `confirmation_required` carrying the `--yes` argv, and
 * nothing is mutated by any of the three AC 1 measures.
 */

const cliPath = registerCliBundle('release-rename-confirm-')

const PLACE_LINES = [
  /Jira version: +v1\.2\.0 → v1\.3\.0 \(pending\)/u,
  /remote new: +origin release\/v1\.3\.0 at the release\/v1\.2\.0 tip \(pending\)/u,
  /PR new: +"Release v1\.3\.0" from release\/v1\.3\.0 \(pending\)/u,
  /child PRs: +#2 \(feature\/child\): base → release\/v1\.3\.0 \(pending\)/u,
  /PR old: +#1 closed with "Superseded by #<new>" \(pending\)/u,
  /remote old: +origin release\/v1\.2\.0 deleted \(pending\)/u,
  /local branch: +release\/v1\.2\.0 → release\/v1\.3\.0 \(pending\)/u,
  /worktree: +\S+\/release\/v1\.2\.0 → \S+\/release\/v1\.3\.0 \(pending\)/u,
  /Orca: +terminals in \S+\/release\/v1\.2\.0 closed before the move/u,
]

describe('release rename: confirm gate', () => {
  it(
    'previews without --yes: exit 2 confirmation_required, rerun = argv + --yes, every place named, nothing mutated',
    async () => {
      await withFixture(cliPath(), { worktree: true }, async (fixture) => {
        addChildPr(fixture)

        const before = snapshot(fixture)
        const run = await runRename(fixture, ['1.2.0', '1.3.0'])

        expect(run.code, output(run)).toBe(2)
        expect(run.json?.status, output(run)).toBe('confirmation_required')
        expect(run.json?.rerun).toStrictEqual(['release', 'rename', '1.2.0', '1.3.0', '--agent', '--json', '--yes'])
        expect(run.json?.plan).toMatchObject({
          old: '1.2.0',
          new: '1.3.0',
          oldBranch: 'release/v1.2.0',
          newBranch: 'release/v1.3.0',
          jira: { from: 'v1.2.0', to: 'v1.3.0', id: fixture.jiraVersionId },
          places: {
            jira: 'pending',
            'remote-push': 'pending',
            'pr-open': 'pending',
            'pr-retarget': 'pending',
            'pr-close': 'pending',
            'remote-delete': 'pending',
            'local-branch': 'pending',
            worktree: 'pending',
          },
          oldPr: 1,
          newPr: null,
          childPrs: [{ number: 2, headRefName: 'feature/child' }],
          worktree: { from: fixture.worktreeDir, to: fixture.worktreePathFor('v1.3.0') },
          reviewersToRedo: ['reviewer-a', 'reviewer-b'],
        })

        const message = String(run.json?.message)

        for (const line of PLACE_LINES) expect(message).toMatch(line)

        expect(message).toContain('approvals and review requests stay on #1 and must be redone')
        expect(message).toContain('reviewer-a')
        expect(message).toContain('reviewer-b (APPROVED)')
        expect(message).toContain('on: push workflows may run for release/v1.3.0')
        expect(message).toContain('may pause up to 10 s after the move')
        expectNothingMutated(fixture, before)
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )

  it(
    'keeps positionals in the rerun argv for a name release and marks absent places "absent"',
    async () => {
      await withFixture(cliPath(), { release: 'checkout-redesign', localBranch: false }, async (fixture) => {
        const before = snapshot(fixture)
        const run = await runRename(fixture, ['checkout-redesign', 'checkout-v2'])

        expect(run.code, output(run)).toBe(2)
        expect(run.json).toMatchObject({
          status: 'confirmation_required',
          rerun: ['release', 'rename', 'checkout-redesign', 'checkout-v2', '--agent', '--json', '--yes'],
          plan: { places: { 'pr-retarget': 'absent', 'local-branch': 'absent', worktree: 'absent' } },
        })
        expect(String(run.json?.message)).toMatch(/local branch: .*\(absent\)/u)
        expectNothingMutated(fixture, before)
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
})
