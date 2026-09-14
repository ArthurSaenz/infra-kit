import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PLUGIN_UPDATE_ARGV } from '../claude-cli'
import { PLUGIN_INSTALL_ARGV } from '../install-plugin'

/**
 * Two rules the plugin driver must never regress on, pinned against EVERY source file rather than the
 * one that happens to hold the argv today: the plugin is installed and updated at project scope only
 * (a user-scope install activates one family's skills in every repo the person opens), and this CLI
 * never registers itself through `claude mcp add` — the plugin serves the MCP server, and a second
 * registration on a machine would shadow it by name and put the session back on the legacy route.
 *
 * A grep across `src/`, deliberately: the argv constants are asserted too, but a constant proves only
 * what one file exports, and the regression this guards is a NEW call site somewhere else.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.md'])

const EXCLUDED_DIRS = new Set(['__tests__', '__fixtures__'])

interface ForbiddenPattern {
  label: string
  pattern: RegExp
  /**
   * A match that is NOT a violation. `claude mcp add --scope local …` is advice this CLI prints for
   * the user's OWN servers (an `ik-mcp` override of one entry) — a command it tells them to run, never
   * one it runs — and is the only tolerated mention.
   */
  allowed?: RegExp
}

const FORBIDDEN: readonly ForbiddenPattern[] = [
  { label: '--scope user', pattern: /--scope\s+user\b/g },
  { label: 'claude mcp add', pattern: /claude\s+mcp\s+add\b/g, allowed: /claude\s+mcp\s+add\s+--scope\s+local\b/ },
  // The executable form: `mcp` and `add` as adjacent argv tokens in either quote style.
  { label: "argv tokens 'mcp', 'add'", pattern: /(['"])mcp\1\s*,\s*(['"])add\2/g },
]

interface Hit {
  file: string
  line: number
  label: string
}

const walkSourceFiles = (dir: string, into: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walkSourceFiles(full, into)
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      into.push(full)
    }
  }

  return into
}

const lineOf = (text: string, index: number): number => {
  return text.slice(0, index).split('\n').length
}

const scanFile = (file: string): Hit[] => {
  const text = fs.readFileSync(file, 'utf8')
  const hits: Hit[] = []

  for (const { label, pattern, allowed } of FORBIDDEN) {
    for (const match of text.matchAll(pattern)) {
      const tail = text.slice(match.index)

      if (allowed?.test(tail) === true) continue

      hits.push({ file, line: lineOf(text, match.index), label })
    }
  }

  return hits
}

/** Hits sorted by path, then line: `readdirSync` order is filesystem-defined and not a fixture. */
const scan = (root: string): { visited: number; hits: Hit[] } => {
  const files = walkSourceFiles(root)
  const hits = files
    .flatMap((file) => {
      return scanFile(file)
    })
    .sort((a, b) => {
      return a.file.localeCompare(b.file) || a.line - b.line
    })

  return { visited: files.length, hits }
}

describe('plugin scope and MCP registration — the argv', () => {
  it('installs at project scope', () => {
    expect([...PLUGIN_INSTALL_ARGV]).toContain('--scope')
    expect(PLUGIN_INSTALL_ARGV[PLUGIN_INSTALL_ARGV.indexOf('--scope') + 1]).toBe('project')
  })

  it('updates at project scope', () => {
    expect([...PLUGIN_UPDATE_ARGV]).toContain('--scope')
    expect(PLUGIN_UPDATE_ARGV[PLUGIN_UPDATE_ARGV.indexOf('--scope') + 1]).toBe('project')
  })
})

describe('plugin scope and MCP registration — every source file', () => {
  it('walks the real source tree, not an empty directory', () => {
    const { visited } = scan(SRC_ROOT)

    expect(visited).toBeGreaterThan(100)
  })

  it('contains no user-scope install and no self-registration through `claude mcp add`', () => {
    const { hits } = scan(SRC_ROOT)

    expect(hits).toEqual([])
  })
})

/**
 * The scanner itself, against a tree it is known to have to reject: a green run above is worth nothing
 * if the walker skips the file or the patterns miss the spelling.
 */
describe('plugin scope and MCP registration — the scanner catches an injection', () => {
  let root: string

  const plant = (relative: string, content: string): void => {
    const full = path.join(root, relative)

    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-scan-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('reports each forbidden spelling with its file and line', () => {
    plant(
      'lib/a.ts',
      "const argv = ['plugin', 'install', 'x', '--scope', 'user']\n// run: claude plugin install --scope user\n",
    )
    plant('lib/deep/b.ts', 'const argv = ["mcp", "add", "infra-kit"]\n')
    plant('commands/c.ts', "spawn('claude', ['mcp', 'add', '--scope', 'project'])\n")
    plant('lib/d.md', 'Run `claude mcp add infra-kit -- infra-kit mcp`\n')

    const { hits } = scan(root)

    expect(hits).toEqual([
      { file: path.join(root, 'commands', 'c.ts'), line: 1, label: "argv tokens 'mcp', 'add'" },
      { file: path.join(root, 'lib', 'a.ts'), line: 2, label: '--scope user' },
      { file: path.join(root, 'lib', 'd.md'), line: 1, label: 'claude mcp add' },
      { file: path.join(root, 'lib', 'deep', 'b.ts'), line: 1, label: "argv tokens 'mcp', 'add'" },
    ])
  })

  it('tolerates the one advisory spelling and nothing near it', () => {
    plant('lib/advice.ts', "'  claude mcp add --scope local <name> -- ik-mcp --name <name>'\n")
    plant('lib/not-advice.ts', "'  claude mcp add --scope project infra-kit'\n")

    const { hits } = scan(root)

    expect(hits).toEqual([{ file: path.join(root, 'lib', 'not-advice.ts'), line: 1, label: 'claude mcp add' }])
  })

  it('skips __tests__ and __fixtures__, where the forbidden spellings are the subject', () => {
    plant('lib/__tests__/x.test.ts', "expect(argv).not.toContain('--scope user')\n")
    plant('lib/__fixtures__/y.ts', "['mcp', 'add']\n")

    expect(scan(root)).toEqual({ visited: 0, hits: [] })
  })
})
