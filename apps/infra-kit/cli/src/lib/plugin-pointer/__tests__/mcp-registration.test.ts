import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from 'src/lib/logger'

import { inspectMcpRegistration } from '../install-state'
import { ensureMcpRegistration } from '../mcp-registration'
import { MARKETPLACE_NAME } from '../plugin-pointer'

/**
 * Criteria 1.1-1.8 — `initCore`'s merge into a consumer repo's `.mcp.json` must be additive and nothing
 * else.
 *
 * Real temp dirs and BYTE assertions throughout, no fs mocking. Bytes are the point: the failure this
 * suite exists to catch is a writer that re-serializes the whole file — clobbering a sibling
 * `linear-server` entry, reindenting, or resorting keys — while the reader still reports `pass`,
 * because the reader only checks that the `infra-kit` key exists.
 */

/** The `infra-kit` + `linear-server` pair, byte-for-byte this repo's own committed `.mcp.json`. */
const BOTH_SERVERS = `{
  "mcpServers": {
    "infra-kit": {
      "type": "stdio",
      "command": "infra-kit",
      "args": ["mcp"]
    },
    "linear-server": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp"
    }
  }
}
`

/** The same file with our server removed — the repair case. */
const SIBLING_ONLY = `{
  "mcpServers": {
    "linear-server": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp"
    }
  }
}
`

/**
 * The sibling's exact bytes at their exact indentation. Asserted as a substring of the result so
 * "byte-identical" means the sibling's own lines, not merely a deep-equal of its parsed value.
 */
const SIBLING_BLOCK = `    "linear-server": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp"
    }`

/** `SIBLING_ONLY` with our entry appended by hand — commas, position and array expansion included. */
const SIBLING_ONLY_REPAIRED = `{
  "mcpServers": {
    "linear-server": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp"
    },
    "infra-kit": {
      "type": "stdio",
      "command": "infra-kit",
      "args": [
        "mcp"
      ]
    }
  }
}
`

/**
 * Tab-indented, and WITHOUT the `infra-kit` key: with the key present the writer no-ops and
 * `detectIndent` is never entered, which is what made an earlier version of criterion 1.3 vacuous.
 */
const TAB_INDENTED = '{\n\t"mcpServers": {\n\t\t"linear-server": {\n\t\t\t"type": "http"\n\t\t}\n\t}\n}\n'

const TAB_INDENTED_REPAIRED =
  '{\n\t"mcpServers": {\n\t\t"linear-server": {\n\t\t\t"type": "http"\n\t\t},\n\t\t"infra-kit": {\n\t\t\t"type": "stdio",\n\t\t\t"command": "infra-kit",\n\t\t\t"args": [\n\t\t\t\t"mcp"\n\t\t\t]\n\t\t}\n\t}\n}\n'

/** infra-kit's server, correctly configured, under the wrong key. */
const MISFILED = `{
  "mcpServers": {
    "ik": {
      "type": "stdio",
      "command": "infra-kit",
      "args": ["mcp"]
    }
  }
}
`

/** Valid JSONC, invalid JSON. Fail-safe, not fail-open: comments must not cost the user their file. */
const WITH_COMMENTS = `{
  // the infra-kit server is added by \`infra-kit setup\`
  "mcpServers": {}
}
`

/** Valid JSON, no `mcpServers` at all — the file the READER calls \`unparseable\` (install-state.ts:228). */
const SCHEMA_ONLY = `{
    "$schema": "https://json.schemastore.org/mcp.json"
}
`

const SCHEMA_ONLY_REPAIRED = `{
    "$schema": "https://json.schemastore.org/mcp.json",
    "mcpServers": {
        "infra-kit": {
            "type": "stdio",
            "command": "infra-kit",
            "args": [
                "mcp"
            ]
        }
    }
}
`

/** The one value this writer is allowed to produce. */
const EXPECTED_ENTRY = { type: 'stdio', command: 'infra-kit', args: ['mcp'] }

let root: string
let mcpPath: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-registration-'))
  mcpPath = path.join(root, '.mcp.json')
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  vi.spyOn(logger, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const write = (content: string): void => {
  fs.writeFileSync(mcpPath, content, 'utf-8')
}

const read = (): string => {
  return fs.readFileSync(mcpPath, 'utf-8')
}

const serversOf = (raw: string): Record<string, unknown> => {
  return (JSON.parse(raw) as { mcpServers: Record<string, unknown> }).mcpServers
}

const warnings = (): string[] => {
  return warnSpy.mock.calls.map((call: readonly unknown[]) => {
    return String(call[0])
  })
}

describe('ensureMcpRegistration — 1.1 the steady state', () => {
  it('leaves a file that already registers the server byte-for-byte alone', async () => {
    write(BOTH_SERVERS)

    const mtime = fs.statSync(mcpPath).mtimeMs

    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })

    const result = ensureMcpRegistration(root)

    expect(result).toEqual({ status: 'unchanged', path: mcpPath, misfiledKey: null })
    expect(read()).toBe(BOTH_SERVERS)
    expect(fs.statSync(mcpPath).mtimeMs).toBe(mtime)
    expect(warnings()).toEqual([])
  })

  it('never touches a deliberately different infra-kit entry', () => {
    const custom = `{\n  "mcpServers": {\n    "${MARKETPLACE_NAME}": {\n      "command": "/usr/local/bin/infra-kit",\n      "args": ["mcp", "--cwd", "/repo"]\n    }\n  }\n}\n`

    write(custom)

    expect(ensureMcpRegistration(root).status).toBe('unchanged')
    expect(read()).toBe(custom)
  })
})

describe('ensureMcpRegistration — 1.2 the repair', () => {
  it('adds the key and leaves the sibling byte-identical and still first', () => {
    write(SIBLING_ONLY)

    const result = ensureMcpRegistration(root)

    expect(result).toEqual({ status: 'added', path: mcpPath, misfiledKey: null })
    expect(read()).toBe(SIBLING_ONLY_REPAIRED)
    expect(read()).toContain(SIBLING_BLOCK)
    expect(Object.keys(serversOf(read()))).toEqual(['linear-server', MARKETPLACE_NAME])
    expect(read().endsWith('}\n')).toBe(true)
    expect(warnings()).toEqual([])
  })

  it('is idempotent: the second run writes nothing', () => {
    write(SIBLING_ONLY)
    ensureMcpRegistration(root)

    const first = read()

    expect(ensureMcpRegistration(root).status).toBe('unchanged')
    expect(read()).toBe(first)
  })
})

describe('ensureMcpRegistration — 1.3 indentation', () => {
  it('indents the added key with tabs when the file uses tabs', () => {
    write(TAB_INDENTED)

    // Guard the guard: with the key present the writer no-ops and detectIndent is never entered.
    expect(serversOf(TAB_INDENTED)[MARKETPLACE_NAME]).toBeUndefined()

    expect(ensureMcpRegistration(root).status).toBe('added')
    expect(read()).toBe(TAB_INDENTED_REPAIRED)
    expect(read()).toContain(`\n\t\t"${MARKETPLACE_NAME}": {`)
    expect(read()).not.toContain('\n  "')
  })

  it('preserves the absence of a trailing newline', () => {
    write(SIBLING_ONLY.trimEnd())

    expect(ensureMcpRegistration(root).status).toBe('added')
    expect(read()).toBe(SIBLING_ONLY_REPAIRED.trimEnd())
  })
})

describe('ensureMcpRegistration — 1.4 a misfiled sibling', () => {
  it('writes nothing and warns with both keys named', () => {
    write(MISFILED)

    const mtime = fs.statSync(mcpPath).mtimeMs
    const result = ensureMcpRegistration(root)

    expect(result).toEqual({ status: 'misfiled', path: mcpPath, misfiledKey: 'ik' })
    expect(read()).toBe(MISFILED)
    expect(fs.statSync(mcpPath).mtimeMs).toBe(mtime)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain('"ik"')
    expect(warnings()[0]).toContain(`"${MARKETPLACE_NAME}"`)
    expect(warnings()[0]).toContain(mcpPath)
  })
})

describe('ensureMcpRegistration — 1.5a unparseable bytes', () => {
  it('refuses a JSONC file, leaving it byte-for-byte alone, with one warn', () => {
    write(WITH_COMMENTS)

    const result = ensureMcpRegistration(root)

    expect(result).toEqual({ status: 'unparseable', path: mcpPath, misfiledKey: null })
    expect(read()).toBe(WITH_COMMENTS)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain(mcpPath)
  })

  it('refuses a JSON array rather than merging into it', () => {
    write('[]\n')

    expect(ensureMcpRegistration(root).status).toBe('unparseable')
    expect(read()).toBe('[]\n')
    expect(warnings()).toHaveLength(1)
  })

  it('refuses to clobber a non-object mcpServers', () => {
    const hostile = '{\n  "mcpServers": "nope"\n}\n'

    write(hostile)

    expect(ensureMcpRegistration(root).status).toBe('unparseable')
    expect(read()).toBe(hostile)
    expect(warnings()).toHaveLength(1)
  })
})

describe('ensureMcpRegistration — 1.5b valid JSON with no mcpServers', () => {
  it('adds the container additively, keeping $schema first and the indent intact', () => {
    write(SCHEMA_ONLY)

    const result = ensureMcpRegistration(root)

    expect(result).toEqual({ status: 'added', path: mcpPath, misfiledKey: null })
    expect(read()).toBe(SCHEMA_ONLY_REPAIRED)
    expect(read()).toContain('    "$schema": "https://json.schemastore.org/mcp.json",')
    expect(Object.keys(JSON.parse(read()) as object)).toEqual(['$schema', 'mcpServers'])
    expect(read().endsWith('}\n')).toBe(true)
    expect(warnings()).toEqual([])
  })

  it('preserves a missing trailing newline on that path too', () => {
    write(SCHEMA_ONLY.trimEnd())

    expect(ensureMcpRegistration(root).status).toBe('added')
    expect(read()).toBe(SCHEMA_ONLY_REPAIRED.trimEnd())
  })
})

describe('ensureMcpRegistration — 1.6 an absent file', () => {
  it('creates it with exactly one server, valid JSON and a trailing newline', () => {
    const result = ensureMcpRegistration(root)

    expect(result).toEqual({ status: 'created', path: mcpPath, misfiledKey: null })
    expect(read()).toBe(
      [
        '{',
        '  "mcpServers": {',
        '    "infra-kit": {',
        '      "type": "stdio",',
        '      "command": "infra-kit",',
        '      "args": [',
        '        "mcp"',
        '      ]',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    expect(Object.keys(serversOf(read()))).toEqual([MARKETPLACE_NAME])
    expect(warnings()).toEqual([])
  })
})

/**
 * Criterion 1.7 — writer↔reader agreement, in the three assertions that replace a
 * `kind === 'ok'` round-trip. That round-trip pins nothing: `install-state.ts:232` is
 * `if (MARKETPLACE_NAME in servers) return { kind: 'ok' }`, so it passes on `{"infra-kit": null}`.
 */
describe('ensureMcpRegistration — 1.7 writer↔reader agreement', () => {
  it('assertion 1 — value-level: the written entry is the stdio server, command and args explicit', () => {
    ensureMcpRegistration(root)

    const entry = serversOf(read())[MARKETPLACE_NAME]

    expect(entry).toEqual(EXPECTED_ENTRY)
    expect(read()).toContain('"command": "infra-kit"')
    expect(read()).toContain('"mcp"')
    expect(inspectMcpRegistration(root)).toEqual({ kind: 'ok' })
  })

  it("assertion 2 — the reverse direction: the writer's own value, filed under `ik`, reads as wrong-key", () => {
    ensureMcpRegistration(root)

    const entry = serversOf(read())[MARKETPLACE_NAME]
    const misfiledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-misfiled-'))

    fs.writeFileSync(path.join(misfiledRoot, '.mcp.json'), JSON.stringify({ mcpServers: { ik: entry } }), 'utf-8')

    // The reader recognises the writer's output AS infra-kit's server, through the same predicate it
    // uses to detect misfiling — which is what actually pins the two halves together.
    expect(inspectMcpRegistration(misfiledRoot)).toEqual({ kind: 'wrong-key', key: 'ik' })

    fs.rmSync(misfiledRoot, { recursive: true, force: true })
  })

  it('assertion 3 — refuse, never add alongside: a misfiled fixture is never joined by a second server', () => {
    write(MISFILED)
    ensureMcpRegistration(root)

    expect(read()).toBe(MISFILED)
    expect(Object.keys(serversOf(read()))).toEqual(['ik'])
    expect(MARKETPLACE_NAME in serversOf(read())).toBe(false)
    // Two infra-kit servers would read as `ok` — :232 short-circuits before :235 ever runs.
    expect(inspectMcpRegistration(root)).toEqual({ kind: 'wrong-key', key: 'ik' })
  })
})

describe('ensureMcpRegistration — 1.8 an unwritable path', () => {
  it('warns once naming the path and returns rather than throwing when .mcp.json is a directory', () => {
    fs.mkdirSync(mcpPath)

    const result = ensureMcpRegistration(root)

    expect(result).toEqual({ status: 'failed', path: mcpPath, misfiledKey: null })
    expect(fs.statSync(mcpPath).isDirectory()).toBe(true)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain(mcpPath)
  })

  /**
   * The read path's own data-loss case, found in review rather than by these fixtures: every read
   * error used to collapse into "absent", which handed a file that EXISTS to the create path and
   * destroyed its siblings. Same loss as pre-mortem 1, reached through the error path instead of the
   * merge path — and silent, because the create path has nothing to warn about.
   */
  it('refuses a present-but-unreadable file instead of replacing it and losing the sibling', () => {
    fs.writeFileSync(mcpPath, BOTH_SERVERS, 'utf-8')
    // Write-only: the read fails while a write would still succeed, which is what makes the old
    // behaviour destructive rather than merely wrong.
    fs.chmodSync(mcpPath, 0o200)

    // Guard the guard: root, or a platform that ignores the mode, would never enter the case under
    // test, and this test would pass while asserting nothing.
    expect(() => {
      return fs.readFileSync(mcpPath, 'utf-8')
    }).toThrow()

    const result = ensureMcpRegistration(root)

    fs.chmodSync(mcpPath, 0o600)

    expect(result).toEqual({ status: 'failed', path: mcpPath, misfiledKey: null })
    expect(fs.readFileSync(mcpPath, 'utf-8')).toBe(BOTH_SERVERS)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain(mcpPath)
  })
})
