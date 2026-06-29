import { ESLint } from 'eslint'
import type { Linter } from 'eslint'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '../src/index.js'
import { makeTree } from './_boundaries-tree.js'
import { code, only } from './_lint-case.js'

// Phase 2: `boundaries/dependencies` — sibling cross-imports (feature<->feature, service<->service)
// must be TYPE-ONLY; the shared layer is the one runtime exception (features/services may import it
// through its barrel; shared may not depend outward). Unlike Phase 1, this rule RESOLVES imports on
// disk, so cases run against a real (temp) scaffold tree from _boundaries-tree.ts: the IMPORT TARGETS
// are written once in beforeAll; each case's IMPORTER is written inline here and linted in place. The
// importer code stays co-located with its expectation — the readability goal — while resolution is
// genuine. A SEPARATE ESLint instance is bound to the temp-dir cwd.
let tree: ReturnType<typeof makeTree>
let eslint: ESLint

beforeAll(async () => {
  tree = makeTree()
  eslint = new ESLint({ cwd: tree.root, overrideConfigFile: true, overrideConfig: await config() })
})

afterAll(() => tree.cleanup())

// Write the inline importer at `relPath` inside the temp tree, lint it, return only boundaries msgs.
const lintAt = async (relPath: string, source: string): Promise<Linter.LintMessage[]> => {
  const abs = path.join(tree.root, relPath)

  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, source)

  const [result] = await eslint.lintText(source, { filePath: abs })

  return only(result?.messages ?? [], 'boundaries/')
}

const expectFlagged = (messages: Linter.LintMessage[]) => {
  expect(messages).toHaveLength(1)
  expect(messages[0]?.message).toContain('no rule allowing')
}

const expectClean = (messages: Linter.LintMessage[]) => {
  expect(messages).toHaveLength(0)
}

describe('boundaries: sibling cross-imports are type-only', () => {
  // POSITIVE CONTROL for the resolver: if the scaffold were misbuilt, `../alpha` would resolve to
  // nothing, classify as `unknown`, and go clean — this assertion fails loudly instead of vacuously.
  it('flags a runtime cross-feature import through the barrel', async () => {
    expectFlagged(
      await lintAt(
        'src/features/beta/x.ts',
        code`
          import { thing } from '../alpha'

          export const a = thing
        `,
      ),
    )
  })

  it('flags a runtime cross-feature import into internals', async () => {
    expectFlagged(
      await lintAt(
        'src/features/beta/x.ts',
        code`
          import { thing } from '../alpha/internal/thing'

          export const a = thing
        `,
      ),
    )
  })

  it('flags a runtime cross-service import through the barrel', async () => {
    expectFlagged(
      await lintAt(
        'src/services/sms/x.ts',
        code`
          import { client } from '../email'

          export const a = client
        `,
      ),
    )
  })

  it('allows a type-only cross-feature import', async () => {
    expectClean(
      await lintAt(
        'src/features/beta/x.ts',
        code`
          import type { Thing } from '../alpha/internal/thing'

          export type A = Thing
        `,
      ),
    )
  })

  it('allows a type-only cross-service import', async () => {
    expectClean(
      await lintAt(
        'src/services/sms/x.ts',
        code`
          import type { EmailClient } from '../email'

          export type A = EmailClient
        `,
      ),
    )
  })

  it('allows a same-feature relative import into own internals', async () => {
    expectClean(
      await lintAt(
        'src/features/beta/x.ts',
        code`
          import { util } from './local/util'

          export const a = util
        `,
      ),
    )
  })
})

describe('boundaries: shared layer', () => {
  it('allows a feature to import shared at runtime through its barrel', async () => {
    expectClean(
      await lintAt(
        'src/features/beta/x.ts',
        code`
          import { sharedUtil } from '../../shared'

          export const a = sharedUtil
        `,
      ),
    )
  })

  it('flags a runtime deep import into shared (barrel only)', async () => {
    expectFlagged(
      await lintAt(
        'src/features/beta/x.ts',
        code`
          import { sharedUtil } from '../../shared/util'

          export const a = sharedUtil
        `,
      ),
    )
  })

  it('flags the shared layer depending outward on a feature', async () => {
    expectFlagged(
      await lintAt(
        'src/shared/x.ts',
        code`
          import { thing } from '../features/alpha'

          export const a = thing
        `,
      ),
    )
  })
})

describe('boundaries: config integrity', () => {
  it('registers the boundaries plugin and the dependencies rule', async () => {
    const flat = await config()
    const withBoundaries = flat.find((c) => c?.plugins?.boundaries)

    expect(withBoundaries).toBeDefined()
    expect(withBoundaries?.rules?.['boundaries/dependencies']?.[0]).toBe('warn')
  })
})
