import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Guard the "no React on machine paths" invariant at the source level (the
// ESLint no-restricted-imports rule enforces it during lint; this asserts it in
// the test suite too, and documents the boundary). Only STATIC imports are
// forbidden — the TTY branch reaches the TUI via a dynamic `import('src/tui/boot')`.
//
// `src/lib/prompts/release-picker.ts` is the one lib module allowed to reach
// the TUI at all, and only dynamically (see the dedicated describe block below):
// commands statically import the shim, and the shim statically imports the
// TUI-owned `./types` module *by type only* — never `ink`/`react`/`src/tui` itself.

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const MACHINE_PATH_FILES = [
  'entry/cli.ts',
  'entry/mcp.ts',
  'commands/release-desc-edit/release-desc-edit.ts',
  'commands/gh-release-deliver/gh-release-deliver.ts',
  'commands/gh-release-deploy-all/gh-release-deploy-all.ts',
  'commands/gh-release-deploy-selected/gh-release-deploy-selected.ts',
  'commands/worktrees-add/worktrees-add.ts',
  'commands/worktrees-remove/worktrees-remove.ts',
  'commands/gh-merge-dev/gh-merge-dev.ts',
]

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

  describe('src/lib/prompts/release-picker.ts (the one lib module allowed to reach the TUI)', () => {
    const relative = 'lib/prompts/release-picker.ts'
    const source = fs.readFileSync(path.join(SRC_DIR, relative), 'utf-8')

    it('does not statically import ink/react/tui', () => {
      for (const specifier of staticImportSpecifiers(source)) {
        expect(isForbidden(specifier), `forbidden static import in ${relative}: ${specifier}`).toBe(false)
      }
    })

    it('reaches the TUI only via a dynamic import', () => {
      // Mirrors the entry/cli.ts assertion above: the picker functions must load
      // the TUI through import('src/tui/boot'), never a static `import ... from`.
      expect(source).toMatch(/import\(\s*['"]src\/tui\/boot['"]\s*\)/)
    })
  })
})
