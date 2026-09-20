import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../../../..')

/** Every `.ts` file under `dir`, excluding tests. Raw source — comments count. */
const sourceFiles = (dir: string): string[] => {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full)

    return entry.isFile() && full.endsWith('.ts') ? [full] : []
  })
}

const CLASSIFIER = path.join(SRC, 'integrations/gh/gh-release-prs/gh-release-prs.ts')
const DEFINITION = path.join(SRC, 'lib/release-utils/release-utils.ts')

/**
 * The release type is decided once, from the PR's base branch, in `classifyReleasePR`. Every
 * consumer reads `pr.type`. A second `detectReleaseType(…)` call anywhere else would re-derive
 * the type from the title — the label, not the fact — which is the exact hole this guard closes
 * (`.omc/plans/merge-dev-hotfix-guard.md`). Comments count too: a copy of the old call in prose
 * is how the next person learns the wrong shape.
 */
describe('release type has one classifier', () => {
  it('detectReleaseType( appears only in its definition and in classifyReleasePR', () => {
    const offenders = sourceFiles(SRC).filter((file) => {
      if (file === CLASSIFIER || file === DEFINITION) return false

      return readFileSync(file, 'utf8').includes('detectReleaseType(')
    })

    expect(offenders).toEqual([])
  })
})
