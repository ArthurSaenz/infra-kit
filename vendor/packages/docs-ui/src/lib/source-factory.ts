import { loader } from 'fumadocs-core/source'
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons'
import { slugsFromData } from 'fumadocs-core/source/plugins/slugs'

type LoaderSource = Parameters<typeof loader>[0]['source']

/**
 * Build the fumadocs source for a docs app. The consuming app injects its generated
 * `source` (from `collections/server`), its docs base URL, and the path -> slug mapper
 * (from the pure `./slugs` helpers — keep node-only modules out of the client bundle).
 */
export const createDocsSource = (params: {
  source: LoaderSource
  baseUrl: string
  pathToSlugs: (filePath: string) => string[]
}) => {
  const { source, baseUrl, pathToSlugs } = params

  // Frontmatter `slug` (declared in the app's source.config.ts) lets a doc choose its own URL.
  // Returns undefined when absent, so we fall back to the package-grouped path slug.
  const slugFromFrontmatter = slugsFromData('slug')

  return loader({
    source,
    baseUrl,
    // Frontmatter `slug` wins; otherwise group scattered files by package into clean URLs
    // instead of raw repo paths. Keep this in sync with getAllDocUrls (prerender).
    slugs: (file) => {
      return slugFromFrontmatter(file) ?? pathToSlugs(file.path)
    },
    plugins: [lucideIconsPlugin()],
  })
}
