import { describe, expect, it } from 'vitest'

import type { FakePr, ReleaseRenameFixture } from 'src/__tests__/helpers/release-rename-fixture'
import { formatPrTitle, parseReleaseRef } from 'src/lib/release-id'

import {
  SPAWN_TEST_TIMEOUT_MS,
  addChildPr,
  openPrsOn,
  output,
  prByNumber,
  registerCliBundle,
  renameOk,
  withFixture,
} from './rename-spawn'

/**
 * @fileoverview
 * Plan §5 AC 6 (spec amendment D1-A): the PR is replaced, not preserved. Exactly one open PR remains,
 * on head `<new>` with the old base, body and metadata; the old PR is CLOSED with the
 * `Superseded by #<n>` marker; PRs based on `<old>` now target `<new>` and stay open; reviews are not
 * carried over, so the follow-up to re-request them is printed.
 */

const cliPath = registerCliBundle('release-rename-pr-')

const OLD = 'release/v1.2.0'
const NEW = 'release/v1.3.0'

const normaliseBody = (body: string): string => {
  return body
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => {
      return line.trimEnd()
    })
    .join('\n')
    .trimEnd()
}

/** Metadata a release PR can carry beyond the fixture defaults, plus a CRLF body with trailing spaces. */
const decorateAnchor = (fixture: ReleaseRenameFixture): void => {
  const body = prByNumber(fixture, 1).body

  fixture.patchPr(1, {
    body: `${body.split('\n').join('  \r\n')}\r\nNotes for QA.   \r\n`,
    isDraft: true,
    labels: [{ name: 'release' }, { name: 'needs-qa' }],
    assignees: [{ login: 'fixture-dev' }, { login: 'release-manager' }],
    milestone: { title: 'Q4' },
  })
}

const expectReplacement = (fixture: ReleaseRenameFixture, oldPr: FakePr, newNumber: number): void => {
  const open = openPrsOn(fixture, [NEW, OLD])

  expect(
    open.map((pr) => {
      return pr.number
    }),
  ).toStrictEqual([newNumber])

  const newPr = prByNumber(fixture, newNumber)

  expect(newPr).toMatchObject({
    headRefName: NEW,
    baseRefName: oldPr.baseRefName,
    title: formatPrTitle(parseReleaseRef('1.3.0'), 'regular'),
    isDraft: oldPr.isDraft,
    labels: oldPr.labels,
    assignees: oldPr.assignees,
    milestone: oldPr.milestone,
  })
  expect(normaliseBody(newPr.body)).toBe(normaliseBody(oldPr.body))

  const closed = prByNumber(fixture, oldPr.number)

  expect(closed.state).toBe('CLOSED')
  expect(
    closed.comments.some((comment) => {
      return comment.body.includes(`Superseded by #${newNumber}`)
    }),
  ).toBe(true)
}

describe('release rename: PR replacement (AC 6)', () => {
  it(
    'opens one replacement PR with the old base, body and metadata, closes the old one with the marker, and retargets children',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        decorateAnchor(fixture)

        const children = [addChildPr(fixture, 'feature/child-a'), addChildPr(fixture, 'feature/child-b')]
        const oldPr = prByNumber(fixture, 1)
        const run = await renameOk(fixture)
        const newNumber = run.json?.newPrNumber as number

        expect(run.json, output(run)).toMatchObject({ oldPrNumber: 1, outcome: 'renamed' })
        expect(newNumber).toBeGreaterThan(Math.max(...children))
        expectReplacement(fixture, oldPr, newNumber)

        for (const child of children) {
          expect(prByNumber(fixture, child)).toMatchObject({ state: 'OPEN', baseRefName: NEW })
        }

        expect(run.json?.followUps).toContainEqual({
          label: `re-request reviews on #${newNumber}`,
          command: `gh pr edit ${newNumber} --add-reviewer reviewer-a,reviewer-b`,
        })
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )

  it(
    'prints the reviewer follow-up line for a human run',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        const run = await renameOk(fixture, ['1.2.0', '1.3.0'], { json: false })

        expect(run.stderr, output(run)).toContain('gh pr edit 2 --add-reviewer reviewer-a,reviewer-b')
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )

  it(
    'prints no reviewer follow-up when nobody was requested or reviewed',
    async () => {
      await withFixture(cliPath(), {}, async (fixture) => {
        fixture.patchPr(1, { reviewRequests: [], latestReviews: [] })

        const run = await renameOk(fixture)

        expect(JSON.stringify(run.json?.followUps), output(run)).not.toContain('--add-reviewer')
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
})
