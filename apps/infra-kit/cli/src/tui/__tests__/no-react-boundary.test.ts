import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Guard the "no React on machine paths" invariant at the source level (the
// ESLint no-restricted-imports rule enforces it during lint; this asserts it in
// the test suite too, and documents the boundary). Only STATIC imports are
// forbidden — the TTY branch reaches the TUI via a dynamic `import('src/tui/boot')`.

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const MACHINE_PATH_FILES = ['entry/cli.ts', 'entry/mcp.ts']

/** Extract the module specifier from each `import ... from '<spec>'` line. */
const staticImportSpecifiers = (source: string): string[] => {
  return source.split('\n').flatMap((line) => {
    const match = /^\s*import\s.+from\s+['"]([^'"]+)['"]/.exec(line)

    return match?.[1] ? [match[1]] : []
  })
}

/** A specifier that would pull React/Ink onto a machine path if imported statically. */
const isForbidden = (specifier: string): boolean => {
  if (specifier === 'ink' || specifier === 'react' || specifier.startsWith('react/')) {
    return true
  }

  return (
    specifier === 'tui' || specifier.endsWith('/tui') || specifier.includes('/tui/') || specifier.startsWith('src/tui')
  )
}

describe('no-React boundary', () => {
  it.each(MACHINE_PATH_FILES)('%s does not statically import ink/react/tui', (relative) => {
    const source = fs.readFileSync(path.join(SRC_DIR, relative), 'utf-8')

    for (const specifier of staticImportSpecifiers(source)) {
      expect(isForbidden(specifier), `forbidden static import in ${relative}: ${specifier}`).toBe(false)
    }
  })

  it('entry/cli.ts reaches the TUI only via a dynamic import', () => {
    const source = fs.readFileSync(path.join(SRC_DIR, 'entry/cli.ts'), 'utf-8')

    // The dynamic import is how the palette is loaded; it must be present and
    // must be a dynamic import() call, never a static `import ... from`.
    expect(source).toMatch(/import\(\s*['"]src\/tui\/boot['"]\s*\)/)
  })
})
