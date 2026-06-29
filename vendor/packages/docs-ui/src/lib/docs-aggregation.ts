import { existsSync } from 'node:fs'
import { glob, readFile } from 'node:fs/promises'
import path from 'node:path'

import { makeDeriveTitle, makePathToSlugs, toPosix } from './slugs.ts'

/**
 * In-place documentation aggregation for a monorepo (RELOCATION-SAFE).
 *
 * Docs are read where they live (no copying). This module is the single source of truth
 * shared by the consuming app's:
 *  - source.config.ts  (fumadocs-mdx: which files to parse + per-file title default)
 *  - src/lib/source.ts (fumadocs loader: file path -> grouped slug — via the pure slugs module)
 *  - vite.config.ts    (prerender: enumerate every doc URL up front)
 *
 * Unlike the original (which hardcoded the repo root five levels up and a literal app content
 * path), the repo root is found by walking up to `pnpm-workspace.yaml`, and the landing content
 * lives at a repo-root convention dir (`spec/docs/`, outside vendor). This keeps the package
 * working no matter how deep it is vendored.
 *
 * NOTE: This module uses `node:fs` and must stay OUT of the client bundle. Import it only from
 * build-time / server config (source.config.ts, vite.config.ts). Route modules use the pure
 * `./slugs` helpers instead.
 */

const WORKSPACE_MARKER = 'pnpm-workspace.yaml'

/**
 * Walk up from `startDir` until a directory containing `pnpm-workspace.yaml` is found.
 *
 * @example
 *     const root = resolveRepoRoot(import.meta.dirname)
 *
 */
export const resolveRepoRoot = (startDir: string): string => {
  let dir = path.resolve(startDir)

  for (;;) {
    if (existsSync(path.join(dir, WORKSPACE_MARKER))) return dir

    const parent = path.dirname(dir)

    if (parent === dir) {
      throw new Error(
        `[@wl/docs-ui] Could not find ${WORKSPACE_MARKER} walking up from ${startDir}. ` +
          'createDocsAggregation must be called with the app directory inside a pnpm workspace.',
      )
    }

    dir = parent
  }
}

interface DocsAggregation {
  repoRoot: string
  appContentRel: string
  includeGlobs: string[]
  metaGlobs: string[]
  ignoreGlobs: string[]
  pathToSlugs: (filePath: string) => string[]
  deriveTitle: (filePath: string) => string
  getAllDocRelPaths: () => Promise<string[]>
  readDocSlugOverride: (absPath: string) => Promise<string[] | null>
  getAllDocUrls: () => Promise<string[]>
}

// Defensive ignores (node_modules etc. are normally not traversed under pnpm symlinks).
const IGNORE_GLOBS = [
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/.turbo/**',
  '!**/.source/**',
  '!**/.output/**',
  '!**/.nitro/**',
  '!**/coverage/**',
  '!**/ios/**',
  '!**/android/**',
]

const IGNORE_RE =
  /(?:^|\/)(?:node_modules|dist|build|\.turbo|\.source|\.output|\.nitro|\.tanstack|coverage|ios|android|Pods)(?:\/|$)/

/**
 * Build the aggregation API bound to a specific app directory.
 *
 * @param appDir the docs app's own directory (pass `import.meta.dirname`). Only used to resolve
 *   the repo root by walking up to `pnpm-workspace.yaml`.
 * @param contentRel the repo-root-relative dir holding the docs app's own landing content.
 *   Defaults to `spec/docs` — the docs app lives inside `vendor/`, so its landing content is
 *   kept per-repo under the repo-root `spec/docs/` dir (outside vendor), NOT alongside the app.
 *
 * @example
 *     const agg = createDocsAggregation({ appDir: import.meta.dirname })
 *
 */
export const createDocsAggregation = (params: { appDir: string; contentRel?: string }): DocsAggregation => {
  const { appDir, contentRel = 'spec/docs' } = params

  const repoRoot = resolveRepoRoot(appDir)
  // The docs app's own content (landing page etc.) lives at the REPO ROOT (per-repo, outside
  // vendor), so the content-rel is the repo-root convention dir — not nested under the app.
  const appContentRel = toPosix(contentRel)

  /**
   * Convention-based include set (relative to repoRoot):
   *  - any `docs/` directory inside an app or package
   *  - the repo-root landing content (`content/`)
   *
   * The apps glob requires a `docs/` directory nested under `apps/<app>/...`, so the docs app's
   * own README and src markdown are not swept in. Plain star/globstar only: fumadocs-mdx's
   * globber supports neither `!` negation nor extglobs.
   *
   * DEPLOY NOTE: these globs are resolved against `repoRoot` (the workspace root) at BUILD time,
   * i.e. the docs site's content lives across the WHOLE monorepo, not inside this package. This is
   * incompatible with `turbo prune` — pruning keeps only @wl/docs-ui's dependency graph and drops
   * the `apps/<app>/docs`, `packages/<pkg>/docs` and `spec/docs` trees, so a pruned build produces an empty docs site.
   * The docs deploy (devops/scripts/deploy-docs-fe.sh) MUST build from the full checkout, not a prune.
   */
  const includeGlobs = [
    'apps/*/**/docs/**/*.{md,mdx}',
    'packages/**/docs/**/*.{md,mdx}',
    `${appContentRel}/**/*.{md,mdx}`,
  ]

  /**
   * Meta files (meta.json / *.yaml) drive optional sidebar ordering. `defineDocs` would
   * otherwise scan EVERY json/yaml under `dir` (the repo root), so this scopes the meta
   * collection to the same doc directories.
   */
  const metaGlobs = [
    'apps/*/**/docs/**/*.{json,yaml}',
    'packages/**/docs/**/*.{json,yaml}',
    `${appContentRel}/**/*.{json,yaml}`,
  ]

  const pathToSlugs = makePathToSlugs({ appContentRel })
  const deriveTitle = makeDeriveTitle({ appContentRel })

  const isIgnoredDocPath = (rel: string): boolean => {
    return IGNORE_RE.test(rel)
  }

  /**
   * All doc files that match the convention, relative to the repo root (sorted, ignores filtered).
   *
   * @example
   *     const rels = await getAllDocRelPaths()
   *
   */
  const getAllDocRelPaths = async (): Promise<string[]> => {
    const out: string[] = []

    for await (const entry of glob(includeGlobs, { cwd: repoRoot })) {
      const rel = toPosix(entry)

      if (!isIgnoredDocPath(rel)) out.push(rel)
    }

    return [...new Set(out)].sort()
  }

  /**
   * Read a top-level frontmatter `slug:` override from a doc file, mirroring fumadocs'
   * `slugsFromData('slug')` (string split on '/'). Returns null when there is no frontmatter
   * block or no `slug` key, so the caller falls back to pathToSlugs.
   *
   * @example
   *     const override = await readDocSlugOverride('/repo/apps/ai/docs/guide.md')
   *
   */
  const readDocSlugOverride = async (absPath: string): Promise<string[] | null> => {
    let raw: string

    try {
      raw = (await readFile(absPath, 'utf8')).replace(/\r\n/g, '\n')
    } catch {
      return null
    }

    const block = raw.match(/^---\n([\s\S]*?)\n---/)

    if (!block) return null

    // Capture the whole value and trim in JS — keeping `[ \t]*` and `.*` separate would let
    // them exchange characters (ReDoS lint).
    const slugLine = block[1].match(/^slug:(.*)$/m)

    if (!slugLine) return null

    const value = slugLine[1].trim().replace(/^["']|["']$/g, '')

    return value.split('/').filter((s) => {
      return s.length > 0
    })
  }

  /**
   * Every doc URL (`/docs/...`) for prerender seeding.
   *
   * @example
   *     const urls = await getAllDocUrls()
   *
   */
  const getAllDocUrls = async (): Promise<string[]> => {
    const rels = await getAllDocRelPaths()

    const urls = await Promise.all(
      rels.map(async (rel) => {
        const override = await readDocSlugOverride(path.join(repoRoot, rel))
        const slugs = override ?? pathToSlugs(rel)

        return slugs.length === 0 ? '/docs' : `/docs/${slugs.join('/')}`
      }),
    )

    return [...new Set(urls)].sort()
  }

  return {
    repoRoot,
    appContentRel,
    includeGlobs,
    metaGlobs,
    ignoreGlobs: IGNORE_GLOBS,
    pathToSlugs,
    deriveTitle,
    getAllDocRelPaths,
    readDocSlugOverride,
    getAllDocUrls,
  }
}
