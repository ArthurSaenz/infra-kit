import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyTargetPlan, commitSyncedPaths, recoveryArgv } from 'src/lib/vendor/sync'

import {
  ESLINT_INDEX,
  OBSOLETE_FILE,
  ROUTE_I,
  ROUTE_ID,
  buildFixture,
  commitAll,
  exists,
  git,
  isolateGitEnv,
  preview,
  readBytes,
  runArgv,
  sync,
  writeFile,
} from './sync-fixture'
import type { Fixture } from './sync-fixture'

const TIMEOUT_MS = 60_000
const SETTINGS = '.claude/settings.json'

let restoreEnv: () => void
let fx: Fixture

beforeAll(() => {
  restoreEnv = isolateGitEnv()
})

beforeEach(() => {
  fx = buildFixture()
})

afterEach(() => {
  fx.cleanup()
})

afterAll(() => {
  restoreEnv()
})

const headBytes = (root: string, rel: string): string => {
  return git(root, ['--literal-pathspecs', 'show', `HEAD:${rel}`])
}

const lines = (stdout: string): string[] => {
  return stdout.split('\n').filter((line) => {
    return line.length > 0
  })
}

const committedNames = (root: string): string[] => {
  return lines(git(root, ['show', '--name-only', '--format=', 'HEAD'])).sort()
}

const allStatus = (roots: readonly string[]): string[] => {
  return roots.map((root) => {
    return git(root, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all'])
  })
}

const writesOf = (plan: { entries: { writes: { target: string }[] }[] }): string[] => {
  return plan.entries.flatMap((entry) => {
    return entry.writes.map((write) => {
      return write.target
    })
  })
}

/** Sync `targetA` once and commit everything, so later syncs start from a clean, synced HEAD. */
const primeTargetA = async (): Promise<void> => {
  await sync(fx.source, fx.targetA)
  commitAll(fx.targetA, 'target: first sync')
}

describe('vendor sync over real git repos: safety', () => {
  it(
    'treats bracketed paths literally when writing, restoring and committing',
    async () => {
      await primeTargetA()

      const oldId = readBytes(fx.targetA, ROUTE_ID)

      writeFile(fx.source, ROUTE_ID, 'export const Id = 2\n')
      commitAll(fx.source, 'source: edit [id]')

      const { source, plan, result } = await sync(fx.source, fx.targetA)

      expect(writesOf(plan)).toEqual([ROUTE_ID])
      expect(readBytes(fx.targetA, ROUTE_ID)).toEqual(readBytes(fx.source, ROUTE_ID))

      // As a glob `[id].tsx` would match `i.tsx`; a local edit there proves the recovery argv leaves it alone.
      writeFile(fx.targetA, ROUTE_I, 'local edit\n')
      runArgv(recoveryArgv(plan))

      expect(readBytes(fx.targetA, ROUTE_ID)).toEqual(oldId)
      expect(fs.readFileSync(path.join(fx.targetA, ROUTE_I), 'utf8')).toBe('local edit\n')

      git(fx.targetA, ['checkout', 'HEAD', '--', ROUTE_I])

      const again = await sync(fx.source, fx.targetA)

      expect(again.result.touched).toEqual(result.touched)
      expect(await commitSyncedPaths(fx.targetA, again.result.touched, `sync ${source.headSha}`)).toEqual({ ok: true })

      const underPackages = committedNames(fx.targetA).filter((name) => {
        return name.startsWith('vendor/packages/')
      })

      expect(underPackages).toEqual([ROUTE_ID])
    },
    TIMEOUT_MS,
  )

  it(
    'hands over the recovery argv before the first write, and that argv restores every tracked file a failed apply touched',
    async () => {
      await primeTargetA()

      writeFile(fx.source, SETTINGS, '{ "hooks": { "changed": true } }\n')
      writeFile(fx.source, ESLINT_INDEX, 'module.exports = { changed: true }\n')
      writeFile(fx.source, 'vendor/configs/eslint-config/zz.js', 'new file\n')
      git(fx.source, ['rm', '-q', OBSOLETE_FILE])
      commitAll(fx.source, 'source: three changes')

      // A directory holding only an ignored file where the new `zz.js` must go: invisible to the dirty
      // preflight, and `rmdirSync` refuses it, so the apply dies after the earlier writes landed.
      writeFile(fx.targetA, 'vendor/configs/eslint-config/zz.js/node_modules/x', 'ignored\n')

      const { source, plan } = await preview(fx.source, fx.targetA)

      expect(plan.status).toBe('changed')

      let seen: { argv: string[]; settingsUntouched: boolean; obsoletePresent: boolean } | undefined

      const apply = applyTargetPlan({
        source,
        plan,
        onBeforeFirstWrite: (argv) => {
          seen = {
            argv,
            settingsUntouched: readBytes(fx.targetA, SETTINGS).toString() === headBytes(fx.targetA, SETTINGS),
            obsoletePresent: exists(fx.targetA, OBSOLETE_FILE),
          }
        },
      })

      await expect(apply).rejects.toThrow()
      expect(seen).toEqual({ argv: recoveryArgv(plan), settingsUntouched: true, obsoletePresent: true })
      // The apply got partway: the delete and the earlier writes landed before the failure.
      expect(exists(fx.targetA, OBSOLETE_FILE)).toBe(false)
      expect(readBytes(fx.targetA, SETTINGS).toString()).not.toBe(headBytes(fx.targetA, SETTINGS))

      runArgv(seen?.argv ?? [])

      expect(lines(git(fx.targetA, ['diff', '--name-only', 'HEAD']))).toEqual([])

      for (const rel of [SETTINGS, ESLINT_INDEX, OBSOLETE_FILE]) {
        expect(readBytes(fx.targetA, rel).toString(), rel).toBe(headBytes(fx.targetA, rel))
      }
    },
    TIMEOUT_MS,
  )

  it(
    'leaves git status of the source and every target byte-identical across a preview',
    async () => {
      await primeTargetA()
      writeFile(fx.source, SETTINGS, '{ "preview": true }\n')
      commitAll(fx.source, 'source: pending change')

      const roots = [fx.source, fx.targetA, fx.targetB]
      const before = allStatus(roots)
      const previews = await Promise.all(
        [fx.targetA, fx.targetB].map((target) => {
          return preview(fx.source, target)
        }),
      )

      expect(
        previews.map(({ plan }) => {
          return plan.status
        }),
      ).toEqual(['changed', 'changed'])
      expect(allStatus(roots)).toEqual(before)
    },
    TIMEOUT_MS,
  )

  it(
    'writes nothing anywhere when probing a dirty source',
    async () => {
      writeFile(fx.source, SETTINGS, '{ "uncommitted": true }\n')
      writeFile(fx.source, '.claude/untracked.md', 'untracked\n')

      const roots = [fx.source, fx.targetA, fx.targetB]
      const before = allStatus(roots)

      await preview(fx.source, fx.targetA)
      await preview(fx.source, fx.targetB)

      expect(allStatus(roots)).toEqual(before)
      expect(exists(fx.targetA, SETTINGS)).toBe(false)
    },
    TIMEOUT_MS,
  )

  it(
    'blocks a target with an uncommitted change under a synced path and leaves it untouched, while the other target syncs',
    async () => {
      writeFile(fx.targetA, '.claude/local.md', 'committed\n')
      commitAll(fx.targetA, 'target: own claude file')
      writeFile(fx.targetA, '.claude/local.md', 'uncommitted edit\n')

      const statusBefore = allStatus([fx.targetA])
      const blocked = await sync(fx.source, fx.targetA)

      expect(blocked.plan.status).toBe('fail')
      expect(blocked.plan.message).toMatch(/^blocked:/u)
      expect(blocked.plan.notes).toContain('.claude/local.md')
      expect(blocked.result).toEqual({ touched: [], manifestWritten: false })
      expect(allStatus([fx.targetA])).toEqual(statusBefore)
      expect(exists(fx.targetA, SETTINGS)).toBe(false)

      const other = await sync(fx.source, fx.targetB)

      expect(other.plan.status).toBe('changed')
      expect(readBytes(fx.targetB, SETTINGS)).toEqual(readBytes(fx.source, SETTINGS))
    },
    TIMEOUT_MS,
  )

  it(
    'commits only the synced paths and leaves an unrelated pre-staged file staged',
    async () => {
      writeFile(fx.targetA, 'notes.txt', 'unrelated\n')
      git(fx.targetA, ['add', 'notes.txt'])

      const { source, result } = await sync(fx.source, fx.targetA)

      expect(await commitSyncedPaths(fx.targetA, result.touched, `sync ${source.headSha}`)).toEqual({ ok: true })
      expect(committedNames(fx.targetA)).toEqual([...result.touched].sort())
      expect(committedNames(fx.targetA)).not.toContain('notes.txt')
      expect(lines(git(fx.targetA, ['diff', '--cached', '--name-only']))).toEqual(['notes.txt'])
    },
    TIMEOUT_MS,
  )
})
