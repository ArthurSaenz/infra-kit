import { makePathToSlugs } from '@/lib/slugs'
import { createDocsSource } from '@/lib/source-factory'
import { docs } from 'collections/server'

import { docsRoute } from './shared'

// The content-rel is injected at build time by vite.config.ts (`define`), so the runtime
// loader gets it without importing the node:fs aggregation module.
const pathToSlugs = makePathToSlugs({ appContentRel: import.meta.env.VITE_DOCS_CONTENT_REL })

export const source = createDocsSource({
  source: docs.toFumadocsSource(),
  baseUrl: docsRoute,
  pathToSlugs,
})
