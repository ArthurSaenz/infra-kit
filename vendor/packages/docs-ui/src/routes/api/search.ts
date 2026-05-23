import { source } from '@/lib/source'
import { createFileRoute } from '@tanstack/react-router'
import { createFromSource } from 'fumadocs-core/search/server'

// Static search: `staticGET` serves the full Orama index as JSON, prerendered to a
// static file at /api/search and consumed by the static client in components/search.tsx.
const server = createFromSource(source, {
  language: 'english',
})

export const Route = createFileRoute('/api/search')({
  server: {
    handlers: {
      GET: async () => {
        return server.staticGET()
      },
    },
  },
})
