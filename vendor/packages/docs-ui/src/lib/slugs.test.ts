import { describe, expect, it } from 'vitest'

import { makePathToSlugs } from './slugs.ts'

// The docs app's own landing content lives at the repo-root `spec/docs/` dir (per-repo, outside
// vendor). The pure slug logic maps that content to clean URLs (and its index to the landing).
const pathToSlugs = makePathToSlugs({ appContentRel: 'spec/docs' })

describe('makePathToSlugs', () => {
  it('groups app docs by package and drops scaffolding segments', () => {
    expect(pathToSlugs('apps/ai/agent/docs/draft.md')).toEqual(['ai-agent', 'draft'])
    expect(pathToSlugs('packages/lib-fe-hooks/docs/use-x.md')).toEqual(['lib-fe-hooks', 'use-x'])
    expect(pathToSlugs('packages/lib-be-api/src/api/auth.md')).toEqual(['lib-be-api-api', 'auth'])
  })

  it('maps the repo-root spec/docs content and folder index/readme to landings', () => {
    expect(pathToSlugs('spec/docs/index.mdx')).toEqual([])
    expect(pathToSlugs('packages/lib-fe-hooks/docs/readme.md')).toEqual(['lib-fe-hooks'])
  })

  it('maps nested spec/docs content under /docs', () => {
    expect(pathToSlugs('spec/docs/guides/intro.mdx')).toEqual(['guides', 'intro'])
  })

  it('treats spec/docs as landing only at the REPO ROOT, not nested inside a package', () => {
    // Regression: landing detection is a path PREFIX match, not a substring match — a package
    // that happens to contain a `spec/docs/` dir must NOT be mistaken for the root landing.
    expect(pathToSlugs('packages/foo/spec/docs/x.md')).toEqual(['foo-spec', 'x'])
  })
})
