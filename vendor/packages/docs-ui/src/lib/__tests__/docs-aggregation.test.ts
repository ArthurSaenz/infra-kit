import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDocsAggregation } from '../docs-aggregation.ts'

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

  it('fails on a file it cannot read instead of falling back to the path slug', async () => {
    await expect(readDocSlugOverride(dir)).rejects.toThrow(/EISDIR/)
  })
})

describe('getAllDocUrls', () => {
  let repoRoot: string

  const writeRepoFile = async (rel: string, body = '# doc\n'): Promise<void> => {
    const file = path.join(repoRoot, rel)

    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, body, 'utf8')
  }

  const getAllDocUrls = () => {
    return createDocsAggregation({ appDir: repoRoot }).getAllDocUrls()
  }

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'docs-repo-'))
    await writeFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('lists one URL per doc', async () => {
    await writeRepoFile('spec/docs/index.mdx')
    await writeRepoFile('packages/lib-fe-hooks/docs/use-x.md')
    await writeRepoFile('apps/ai/agent/docs/guide.md', '---\nslug: guides/agent\n---\n')

    expect(await getAllDocUrls()).toEqual(['/docs', '/docs/guides/agent', '/docs/lib-fe-hooks/use-x'])
  })

  it('refuses two docs whose paths map to the same slug, naming both files', async () => {
    await writeRepoFile('apps/a/b/docs/setup.md')
    await writeRepoFile('apps/a-b/docs/setup.md')

    await expect(getAllDocUrls()).rejects.toThrow(
      '/docs/a-b/setup is claimed by both apps/a-b/docs/setup.md and apps/a/b/docs/setup.md',
    )
  })

  it('refuses a frontmatter slug that collides with another doc, naming both files', async () => {
    await writeRepoFile('packages/billing/docs/changelog.md')
    await writeRepoFile('packages/api/docs/release-notes.md', '---\nslug: billing/changelog\n---\n')

    await expect(getAllDocUrls()).rejects.toThrow(
      '/docs/billing/changelog is claimed by both packages/api/docs/release-notes.md and packages/billing/docs/changelog.md',
    )
  })

  it('skips a directory whose name ends in .md and still lists the docs inside it', async () => {
    await writeRepoFile('packages/lib/docs/notes.md/inner.md')

    expect(await getAllDocUrls()).toEqual(['/docs/lib/notes.md/inner'])
  })
})

describe('getAllDocRelPaths', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'docs-rels-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
    await mkdir(path.join(root, 'packages/a/docs'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('skips a dangling symlink instead of aborting the build', async () => {
    const docs = path.join(root, 'packages/a/docs')

    await writeFile(path.join(docs, 'real.md'), '# real\n', 'utf8')
    await symlink(path.join(docs, 'missing.md'), path.join(docs, 'foo.md'))

    const { getAllDocRelPaths } = createDocsAggregation({ appDir: root })

    expect(await getAllDocRelPaths()).toEqual(['packages/a/docs/real.md'])
  })
})
