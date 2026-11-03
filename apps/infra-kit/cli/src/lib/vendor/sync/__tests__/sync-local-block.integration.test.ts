import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { vendorCheck } from 'src/commands/vendor-check'

import { buildFixture, commitAll, isolateGitEnv, preview, readBytes, sync, writeFile } from './sync-fixture'
import type { Fixture } from './sync-fixture'

const TIMEOUT_MS = 60_000

// Under `.claude` and `vendor/configs`, both mirrored by the fixture's SPEC; only vendor/ is in the manifest.
const IGNORE_FILE = '.claude/.prettierignore'
const VENDOR_IGNORE_FILE = 'vendor/configs/eslint-config/.gitignore'
const LOCAL = '# infra-kit:local-start\n# deploys need it\n!**/src/coverage\n# infra-kit:local-end'

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

const text = (root: string, rel: string): string => {
  return readBytes(root, rel).toString('utf8')
}

describe('vendor sync over real git repos: the repo-owned local block', () => {
  it(
    "keeps the target's local block across a source change and plans nothing while only that block differs",
    async () => {
      for (const rel of [IGNORE_FILE, VENDOR_IGNORE_FILE]) writeFile(fx.source, rel, 'coverage\n')
      commitAll(fx.source, 'source: ignore files')
      await sync(fx.source, fx.targetA)

      for (const rel of [IGNORE_FILE, VENDOR_IGNORE_FILE]) writeFile(fx.targetA, rel, `coverage\n${LOCAL}\n`)
      commitAll(fx.targetA, 'target: local lines')

      expect((await preview(fx.source, fx.targetA)).plan.status).toBe('ok')
      expect((await vendorCheck({ cwd: fx.targetA })).structuredContent.status).toBe('clean')

      for (const rel of [IGNORE_FILE, VENDOR_IGNORE_FILE]) writeFile(fx.source, rel, 'coverage\ndist\n')
      commitAll(fx.source, 'source: ignore dist')

      const { plan } = await sync(fx.source, fx.targetA)

      expect(plan.status).toBe('changed')

      for (const rel of [IGNORE_FILE, VENDOR_IGNORE_FILE])
        expect(text(fx.targetA, rel)).toBe(`coverage\ndist\n${LOCAL}\n`)

      expect((await vendorCheck({ cwd: fx.targetA })).structuredContent.status).toBe('clean')
    },
    TIMEOUT_MS,
  )

  it(
    "replaces the source's own block with the target's, and mirrors the source verbatim into a target without one",
    async () => {
      writeFile(fx.source, IGNORE_FILE, 'a\n# infra-kit:local-start\nstarter-only\n# infra-kit:local-end\nb\n')
      commitAll(fx.source, 'source: block')
      await sync(fx.source, fx.targetA)
      await sync(fx.source, fx.targetB)
      commitAll(fx.targetB, 'target: first sync')

      writeFile(fx.targetA, IGNORE_FILE, `a\n${LOCAL}\nb\n`)
      commitAll(fx.targetA, 'target: own block')
      writeFile(fx.source, IGNORE_FILE, 'a\n# infra-kit:local-start\nstarter-only\n# infra-kit:local-end\nb\nc\n')
      commitAll(fx.source, 'source: c')

      await sync(fx.source, fx.targetA)
      await sync(fx.source, fx.targetB)

      expect(text(fx.targetA, IGNORE_FILE)).toBe(`a\n${LOCAL}\nb\nc\n`)
      expect(readBytes(fx.targetB, IGNORE_FILE)).toEqual(readBytes(fx.source, IGNORE_FILE))
    },
    TIMEOUT_MS,
  )
})
