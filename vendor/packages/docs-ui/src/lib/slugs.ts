/**
 * Pure slug/title logic for the docs template. NO `node:fs` (or any node-only) imports — this
 * module is bundled into the client via the fumadocs loader (`source-factory`), so keeping it
 * fs-free prevents node built-ins from leaking into the browser bundle.
 *
 * The fs-bound aggregation lives in `./docs-aggregation`, which imports these helpers.
 */

/**
 * Normalize Windows separators to POSIX. Avoids `path.sep` so this stays node-free.
 *
 * @example
 *     const posix = toPosix('packages\\lib\\docs\\index.md')
 *
 */
export const toPosix = (p: string): string => {
  return p.split('\\').join('/')
}

// Path segments dropped when building a package group name.
export const GROUP_DROP = new Set(['apps', 'packages', 'configs', 'src'])

export const titleCase = (value: string): string => {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => {
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

/**
 * Build the path -> grouped-slug mapper, bound to the app's content dir (relative to the repo
 * root). Ported from the original docs-aggregation `pathToSlugs`, reading `appContentRel` from
 * the closure instead of a module constant so it works regardless of where the app lives.
 *
 *  - apps/ai/agent/docs/draft.md             -> ['ai-agent', 'draft']
 *  - packages/lib-fe-hooks/docs/use-x.md     -> ['lib-fe-hooks', 'use-x']
 *  - packages/lib-be-api/src/api/auth.md     -> ['lib-be-api-api', 'auth']
 *  - <appContentRel>/index.mdx               -> []          (docs landing)
 *  - a folder readme/index                   -> ['<group>']  (group landing)
 *
 * @example
 *     const pathToSlugs = makePathToSlugs({ appContentRel: 'spec/docs' })
 *     pathToSlugs('apps/ai/agent/docs/draft.md') // => ['ai-agent', 'draft']
 *
 */
export const makePathToSlugs = (params: { appContentRel: string }) => {
  const { appContentRel } = params

  return (filePath: string): string[] => {
    const noExt = toPosix(filePath).replace(/\.(mdx|md)$/i, '')

    // The docs app's own landing content (repo-root `content/`) maps directly under /docs.
    // PREFIX match — not indexOf — so a generic content-rel like 'content' never false-matches
    // an unrelated path such as 'packages/foo/docs/content-guide'.
    if (noExt === `${appContentRel}/index`) return []

    if (noExt.startsWith(`${appContentRel}/`)) {
      const sub = noExt.slice(appContentRel.length + 1)

      if (!sub || sub === 'index') return []

      return sub.split('/').map((s) => {
        return s.toLowerCase()
      })
    }

    let parts = noExt.split('/').filter(Boolean)
    const anchor = parts.findIndex((s) => {
      return s === 'apps' || s === 'packages' || s === 'configs'
    })

    if (anchor >= 0) parts = parts.slice(anchor)

    const docsIdx = parts.lastIndexOf('docs')
    const groupParts = docsIdx >= 0 ? parts.slice(0, docsIdx) : parts.slice(0, -1)
    const docParts = docsIdx >= 0 ? parts.slice(docsIdx + 1) : parts.slice(-1)

    const group =
      groupParts
        .filter((p) => {
          return !GROUP_DROP.has(p)
        })
        .join('-') || 'general'
    const docSlugs = docParts.map((s) => {
      return s.toLowerCase()
    })

    if (docSlugs.length === 1 && (docSlugs[0] === 'readme' || docSlugs[0] === 'index')) {
      return [group]
    }

    return [group, ...docSlugs]
  }
}

/**
 * Build the path -> human-readable title fallback, bound to the same app content dir.
 *
 * @example
 *     const deriveTitle = makeDeriveTitle({ appContentRel: 'spec/docs' })
 *     deriveTitle('apps/ai/agent/docs/use-hook.md') // => 'Use Hook'
 *
 */
export const makeDeriveTitle = (params: { appContentRel: string }) => {
  const pathToSlugs = makePathToSlugs(params)

  return (filePath: string): string => {
    const slugs = pathToSlugs(filePath)
    const last = slugs.at(-1)

    if (!last) return 'Overview'

    return titleCase(last)
  }
}
