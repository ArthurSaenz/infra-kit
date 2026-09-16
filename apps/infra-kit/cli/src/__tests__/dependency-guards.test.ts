import { describe, expect, it } from 'vitest'

import packageJson from '../../package.json' with { type: 'json' }

/**
 * The only guard for the recurring `catalog:`-in-published-runtime-deps bug (it has shipped broken
 * twice) — lives outside `src/mcp` since it lived in a file about to be deleted with the MCP bundle.
 */

describe('u7c — no `catalog:` protocol appears in runtime dependencies', () => {
  const deps = packageJson.dependencies as Record<string, string>

  it('u7c: no `catalog:` protocol appears in runtime dependencies', () => {
    const catalogged = Object.entries(deps)
      .filter(([, range]) => {
        return range.startsWith('catalog:')
      })
      .map(([name]) => {
        return name
      })

    expect(catalogged, 'catalog: in runtime deps breaks install on npm AND pnpm').toEqual([])
  })
})
