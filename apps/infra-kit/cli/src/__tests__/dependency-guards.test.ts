import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
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

const SRC = join(__dirname, '..')

const tsFilesUnder = (dir: string): string[] => {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)

    if (entry.isDirectory()) return tsFilesUnder(full)

    return entry.name.endsWith('.ts') ? [full] : []
  })
}

// The SDK left with the server; a re-import anywhere under `src` — tests included — would silently
// re-add a runtime or dev dep the manifest no longer declares.
describe('u6 — the MCP SDK is gone from every source file', () => {
  it('u6: zero `@modelcontextprotocol` import lines under src', () => {
    const importers = tsFilesUnder(SRC).filter((file) => {
      return /from\s*['"]@modelcontextprotocol\//.test(readFileSync(file, 'utf-8'))
    })

    expect(
      importers.map((file) => {
        return relative(SRC, file)
      }),
    ).toEqual([])
  })
})
