import type { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { vendorCheck } from 'src/commands/vendor-check'
import { readManifest } from 'src/lib/vendor'
import { commitSyncedPaths, syncCommitMessage } from 'src/lib/vendor/sync'

import {
  CONSUMER_SERVERLESS,
  EXCLUDED_SOURCE_FILE,
  HOOKS,
  IGNORED_SOURCE_FILE,
  LINK_PATH,
  LINK_TEXT,
  OBSOLETE_FILE,
  PLANTED_IGNORED,
  SOURCE_TRACKED,
  buildFixture,
  commitAll,
  exists,
  git,
  isolateGitEnv,
  preview,
  readBytes,
  sync,
} from './sync-fixture'
import type { Fixture } from './sync-fixture'

const TIMEOUT_MS = 60_000
const OLD_TIME = new Date('2020-01-01T00:00:00Z')

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

const snapshotBytes = (root: string, rels: readonly string[]): Map<string, Buffer> => {
  return new Map(
    rels.map((rel) => {
      return [rel, readBytes(root, rel)]
    }),
  )
}

describe('vendor sync over real git repos: content', () => {
  it(
    'copies tracked files byte-identical with modes and links, skips ignored and excluded files, and deletes what the source deleted',
    async () => {
      const first = await sync(fx.source, fx.targetA)

      expect(first.plan.status).toBe('changed')

      for (const rel of SOURCE_TRACKED) expect(readBytes(fx.targetA, rel)).toEqual(readBytes(fx.source, rel))

      expect(exists(fx.targetA, IGNORED_SOURCE_FILE)).toBe(false)
      expect(exists(fx.targetA, path.dirname(EXCLUDED_SOURCE_FILE))).toBe(false)

      for (const hook of HOOKS) expect(fs.statSync(path.join(fx.targetA, hook)).mode & 0o777).toBe(0o755)

      expect(fs.statSync(path.join(fx.targetA, '.claude/settings.json')).mode & 0o777).toBe(0o644)

      const link = path.join(fx.targetA, LINK_PATH)

      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
      expect(fs.readlinkSync(link)).toBe(LINK_TEXT)
      expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8')).toBe('# shadcn\n')

      commitAll(fx.targetA, 'target: first sync')
      git(fx.source, ['rm', '-q', OBSOLETE_FILE])
      git(fx.source, ['commit', '-q', '-m', 'source: drop obsolete'])

      const second = await sync(fx.source, fx.targetA)

      expect(
        second.plan.entries.flatMap((entry) => {
          return entry.deletes
        }),
      ).toEqual([OBSOLETE_FILE])
      expect(exists(fx.targetA, OBSOLETE_FILE)).toBe(false)
      // The delete left `.claude/obsolete/` empty, so it is pruned too.
      expect(exists(fx.targetA, path.dirname(OBSOLETE_FILE))).toBe(false)
    },
    TIMEOUT_MS,
  )

  it(
    'leaves ignored files and a tracked excluded file under a synced directory byte-identical',
    async () => {
      const owned = [...PLANTED_IGNORED, CONSUMER_SERVERLESS]
      const before = snapshotBytes(fx.targetB, owned)

      const { plan } = await sync(fx.source, fx.targetB)

      expect(plan.status).toBe('changed')
      expect(snapshotBytes(fx.targetB, owned)).toEqual(before)
      expect(git(fx.targetB, ['ls-files', '--', CONSUMER_SERVERLESS]).trim()).toBe(CONSUMER_SERVERLESS)
    },
    TIMEOUT_MS,
  )

  it(
    'round trip in CI shape: a fresh clone of the synced target passes vendor check with no drift',
    async () => {
      const { source, result } = await sync(fx.source, fx.targetB)

      expect(result.manifestWritten).toBe(true)

      const manifest = readManifest(path.join(fx.targetB, 'vendor'))

      // The consumer's tracked file is in the manifest; its ignored files are not.
      expect(Object.keys(manifest.files)).toContain('configs/serverless-config/serverless.yml')
      expect(
        Object.keys(manifest.files).some((rel) => {
          return rel.includes('coverage/')
        }),
      ).toBe(false)

      commitAll(fx.targetB, syncCommitMessage(source.name, source.headSha))

      const clone = path.join(fx.tmp, 'target-b-clone')

      git(fx.tmp, ['clone', '-q', fx.targetB, clone])

      const { structuredContent } = await vendorCheck({ cwd: clone })

      expect(structuredContent).toMatchObject({ status: 'clean', ok: true, added: [], modified: [], removed: [] })
    },
    TIMEOUT_MS,
  )

  it(
    'writes no unchanged file on a second sync, and a manifest rebuilt without copies hashes every file the same',
    async () => {
      const first = await sync(fx.source, fx.targetB)
      const firstManifest = readManifest(path.join(fx.targetB, 'vendor'))

      expect(await commitSyncedPaths(fx.targetB, first.result.touched, 'first sync')).toEqual({ ok: true })

      const copied = first.plan.entries.flatMap((entry) => {
        return entry.writes.map((write) => {
          return write.target
        })
      })

      for (const rel of copied) fs.lutimesSync(path.join(fx.targetB, rel), OLD_TIME, OLD_TIME)

      const again = await preview(fx.source, fx.targetB)

      expect(again.plan.status).toBe('ok')
      expect(
        again.plan.entries.flatMap((entry) => {
          return entry.writes
        }),
      ).toEqual([])

      // A missing manifest makes the row `changed` with zero copies, so the manifest is rebuilt purely by
      // hashing the files already on disk.
      fs.rmSync(path.join(fx.targetB, 'vendor/.sync-manifest.json'))

      const rebuilt = await sync(fx.source, fx.targetB)

      expect(rebuilt.plan.status).toBe('changed')
      expect(
        rebuilt.plan.entries.flatMap((entry) => {
          return entry.writes
        }),
      ).toEqual([])
      expect(rebuilt.result.manifestWritten).toBe(true)

      for (const rel of copied) {
        expect(fs.lstatSync(path.join(fx.targetB, rel)).mtime.getTime(), rel).toBe(OLD_TIME.getTime())
      }

      const secondManifest = readManifest(path.join(fx.targetB, 'vendor'))

      expect(secondManifest.files).toEqual(firstManifest.files)
      expect(secondManifest.fileCount).toBe(firstManifest.fileCount)
    },
    TIMEOUT_MS,
  )
})
