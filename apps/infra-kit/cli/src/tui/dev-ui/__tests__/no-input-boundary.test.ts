import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * HARD INVARIANT guard: the Ink boot components under `src/tui/dev-ui/` are OUTPUT-ONLY. None of them
 * may call `useInput` — it arms Ink's raw mode + Ctrl-C interception, which would steal SIGINT from the
 * process signal handler that owns dev-server shutdown. This asserts the invariant structurally so a
 * future edit that adds keyboard handling to the boot UI fails loudly here.
 */
const DEV_UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Every source file under `src/tui/dev-ui/` except this test directory. */
const sourceFiles = (dir: string): string[] => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(full)
    }

    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : []
  })
}

describe('dev-ui boot components — no useInput', () => {
  it('no boot component imports or calls useInput (raw mode must stay off)', () => {
    const files = sourceFiles(DEV_UI_DIR)

    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8')
      // Flag an actual USE, not the prose in the invariant comments (which reference `useInput` by name):
      // a call `useInput(` or an `import { … useInput … } from 'ink'`. Both are linear regexes.
      const callsUseInput = /\buseInput\s*\(/.test(source)
      const importsUseInput = source.split('\n').some((line) => {
        return line.includes('useInput') && /from\s*['"]ink['"]/.test(line)
      })

      expect(callsUseInput || importsUseInput, `forbidden useInput in ${path.basename(file)}`).toBe(false)
    }
  })
})
