import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDocsAggregation } from './docs-aggregation.ts'

// readDocSlugOverride is pure frontmatter parsing (independent of repoRoot/appDir), exposed via
// the factory. Resolve against this package's own dir — resolveRepoRoot walks up to the workspace.
const { readDocSlugOverride } = createDocsAggregation({ appDir: import.meta.dirname })

describe('readDocSlugOverride', () => {
  let dir: string

  const writeDoc = async (name: string, body: string): Promise<string> => {
    const file = path.join(dir, name)

    await writeFile(file, body, 'utf8')

    return file
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'docs-slug-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads a plain frontmatter slug', async () => {
    const file = await writeDoc('plain.md', '---\ntitle: Changelog\nslug: changelog\n---\n# hi\n')

    expect(await readDocSlugOverride(file)).toEqual(['changelog'])
  })

  it('splits a nested slug and strips quotes', async () => {
    const dq = await writeDoc('dq.md', '---\nslug: "guides/intro"\n---\n')
    const sq = await writeDoc('sq.md', "---\nslug: 'guides/intro'\n---\n")

    expect(await readDocSlugOverride(dq)).toEqual(['guides', 'intro'])
    expect(await readDocSlugOverride(sq)).toEqual(['guides', 'intro'])
  })

  it('tolerates CRLF line endings', async () => {
    const file = await writeDoc('crlf.md', '---\r\ntitle: X\r\nslug: changelog\r\n---\r\n')

    expect(await readDocSlugOverride(file)).toEqual(['changelog'])
  })

  it('returns null when there is no slug key or no frontmatter block', async () => {
    const noSlug = await writeDoc('no-slug.md', '---\ntitle: X\n---\n')
    const noBlock = await writeDoc('no-block.md', '# Just a heading\nslug: not-frontmatter\n')

    expect(await readDocSlugOverride(noSlug)).toBeNull()
    expect(await readDocSlugOverride(noBlock)).toBeNull()
  })

  it('returns null for a missing file', async () => {
    expect(await readDocSlugOverride(path.join(dir, 'does-not-exist.md'))).toBeNull()
  })
})
