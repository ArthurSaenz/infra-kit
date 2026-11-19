import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { ReleaseRenameFixture } from 'src/__tests__/helpers/release-rename-fixture'

import {
  NEW_SUFFIX,
  SPAWN_TEST_TIMEOUT_MS,
  git,
  output,
  registerCliBundle,
  renameOk,
  withFixture,
} from './rename-spawn'

/**
 * @fileoverview
 * Plan §5 AC 7, spawned wiring only (the sweep's timing cases live in `sweep-after-move.test.ts`): the
 * worktree moves to `<root>-worktrees/release/<new>` on `release/<new>` with its uncommitted state
 * intact, the old path is gone at exit, Orca terminals are closed before the move and reopened after it
 * only when `worktrees.openInOrca` is true. `pnpm` is the fixture's no-op stub on PATH, so the follow-up
 * install never reaches the network.
 */

const cliPath = registerCliBundle('release-rename-worktree-')

const porcelain = (fixture: ReleaseRenameFixture, dir: string): string => {
  return git(fixture, dir, ['status', '--porcelain'])
}

const indexOfCall = (log: string[][], prefix: string[]): number => {
  return log.findIndex((argv) => {
    return prefix.every((token, index) => {
      return argv[index] === token
    })
  })
}

const expectMoved = (fixture: ReleaseRenameFixture, statusBefore: string): string => {
  const newPath = fixture.worktreePathFor(NEW_SUFFIX)

  expect(existsSync(fixture.worktreeDir)).toBe(false)
  expect(git(fixture, newPath, ['branch', '--show-current']).trim()).toBe('release/v1.3.0')
  expect(porcelain(fixture, newPath)).toBe(statusBefore)
  expect(git(fixture, fixture.repoDir, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${newPath}\n`)

  return newPath
}

/** The old path's terminal is listed and closed while the old path still exists (the fake refuses otherwise). */
const expectClosedBeforeMove = (fixture: ReleaseRenameFixture, handle: string): number => {
  const log = fixture.orcaLog()
  const listOld = indexOfCall(log, ['terminal', 'list', '--worktree', `path:${fixture.worktreeDir}`])
  const close = indexOfCall(log, ['terminal', 'close', '--terminal', handle])

  expect(listOld, JSON.stringify(log)).toBeGreaterThanOrEqual(0)
  expect(close, JSON.stringify(log)).toBeGreaterThan(listOld)
  expect(
    fixture.orcaState().terminals.some((terminal) => {
      return terminal.handle === handle
    }),
  ).toBe(false)

  return close
}

const OPEN_IN_ORCA_CASES = [
  { openInOrca: true, reopened: true },
  { openInOrca: false, reopened: false },
] as const

describe('release rename: worktree move (AC 7)', () => {
  it.each(OPEN_IN_ORCA_CASES)(
    'moves the worktree keeping uncommitted files; openInOrca=$openInOrca → reopened=$reopened',
    async ({ openInOrca, reopened }) => {
      const options = { worktree: true, infraKitConfig: { worktrees: { openInOrca } } }

      await withFixture(cliPath(), options, async (fixture) => {
        const handle = fixture.addOrcaTerminal(fixture.worktreeDir, 'release v1.2.0')
        const statusBefore = porcelain(fixture, fixture.worktreeDir)

        expect(statusBefore).toContain('?? untracked.txt')
        expect(statusBefore).toContain(' M release.txt')

        const run = await renameOk(fixture)
        const newPath = expectMoved(fixture, statusBefore)
        const close = expectClosedBeforeMove(fixture, handle)
        const create = indexOfCall(fixture.orcaLog(), ['terminal', 'create', '--worktree', `path:${newPath}`])

        expect(run.json, output(run)).toMatchObject({ worktreePath: newPath, orcaReopened: reopened, install: 'ok' })

        if (reopened) {
          expect(create).toBeGreaterThan(close)
        } else {
          expect(create).toBe(-1)
          expect(run.json?.followUps).toContainEqual({
            label: 'open an Orca terminal in the moved worktree',
            command: `orca terminal create --worktree path:${newPath} --focus`,
          })
        }
      })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
})
