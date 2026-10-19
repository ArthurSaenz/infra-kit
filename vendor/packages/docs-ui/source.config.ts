import { defineConfig, defineDocs, frontmatterSchema } from 'fumadocs-mdx/config'
import { z } from 'zod'

import { createDocsAggregation } from './src/lib/docs-aggregation'

const { repoRoot, includeGlobs, ignoreGlobs, metaGlobs, deriveTitle } = createDocsAggregation({
  appDir: import.meta.dirname,
})

/**
 * Read docs in-place from across the monorepo (no copying). `dir` is the repo root and
 * `files` selects only the convention-based set. Files without a frontmatter `title`
 * fall back to a path-derived title so every page renders with a heading.
 */
export const docs = defineDocs({
  dir: repoRoot,
  docs: {
    files: [...includeGlobs, ...ignoreGlobs],
    postprocess: {
      includeProcessedMarkdown: true,
    },
    schema: (ctx) => {
      return frontmatterSchema.extend({
        title: z.string().default(deriveTitle(ctx.path)),
        // Optional per-file URL override. Read by the loader's `slugs` fn via
        // `slugsFromData('slug')`; pageSchema strips unknown keys, so it must be declared
        // here to survive into `file.data`.
        slug: z.string().optional(),
      })
    },
  },
  meta: {
    // Scope meta scanning to doc dirs only — otherwise it scans every JSON in the repo.
    files: [...metaGlobs, ...ignoreGlobs],
  },
})

export default defineConfig()
