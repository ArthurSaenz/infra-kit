import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { inspectLegacyMcpRegistration, isInfraKitServerEntry } from '../mcp-registration'

/** The entry the CLI used to write into consumer repos — the shape `isInfraKitServerEntry` recognises. */
const buildServerEntry = (): Record<string, unknown> => {
  return { type: 'stdio', command: 'infra-kit', args: ['mcp'] }
}

/** The dep-install spelling a repo that pinned infra-kit wrote by hand — the predicate's other half. */
const DIST_LAUNCHER = { command: 'node', args: ['./node_modules/infra-kit/dist/mcp.js'] }

/**
 * The writer-free reader of a consumer repo's `.mcp.json` (archived plan docs/archive/mcp/mcp-via-plugin-migration-plan.md
 * §3.3, "What `ensureMcpRegistration` becomes").
 *
 * Two properties, asserted on every case: the VERDICT, and that NOTHING WAS WRITTEN — mtime and bytes
 * identical, or the file still absent. Real temp dirs, no fs mocking: the previous occupant of this
 * module wrote the key on `absent`, and the regression this suite exists to catch is a branch that
 * quietly writes again. Bytes and mtime are read back rather than spied — `vi.spyOn` cannot intercept
 * a named fs import, so a spy that saw zero writes would pass while the write happened.
 */

/** The `infra-kit` + `linear-server` pair, byte-for-byte what a consumer's committed file carried. */
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

/** The same file after the consumer PR: the plugin serves the server, the sibling stays. */
const SIBLING_ONLY = `{
  "mcpServers": {
    "linear-server": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp"
    }
  }
}
`

/** infra-kit's server, correctly configured, under the wrong key — the one fault the reader reports. */
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

/**
 * A proxy whose ARGUMENTS mention infra-kit. The old substring predicate read this as a misfiled
 * server and painted a correct file red (plan §5 step 2.4, edit 8).
 */
const PROXY_NAMED_LIKE_US = `{
  "mcpServers": {
    "grafana": {
      "type": "stdio",
      "command": "ik-mcp",
      "args": ["--name", "infra-kit-x", "--", "mcp-grafana"]
    }
  }
}
`

/** Valid JSON, no `mcpServers` — the reader cannot tell whether a key is in it. */
const SCHEMA_ONLY = `{
    "$schema": "https://json.schemastore.org/mcp.json"
}
`

let root: string
let mcpPath: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-registration-'))
  mcpPath = path.join(root, '.mcp.json')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** A file with a past mtime, so an unchanged mtime after the call proves no write, not a fast one. */
const writeAged = (content: string): { bytes: string; mtimeMs: number } => {
  fs.writeFileSync(mcpPath, content, 'utf-8')

  const aged = new Date(Date.now() - 60_000)

  fs.utimesSync(mcpPath, aged, aged)

  return { bytes: content, mtimeMs: fs.statSync(mcpPath).mtimeMs }
}

const expectUntouched = ({ bytes, mtimeMs }: { bytes: string; mtimeMs: number }): void => {
  expect(fs.readFileSync(mcpPath, 'utf-8')).toBe(bytes)
  expect(fs.statSync(mcpPath).mtimeMs).toBe(mtimeMs)
}

describe('inspectLegacyMcpRegistration — verdicts', () => {
  it('reports a leftover infra-kit key as stale, and writes nothing', () => {
    const before = writeAged(BOTH_SERVERS)

    expect(inspectLegacyMcpRegistration(root)).toEqual({ kind: 'stale' })
    expectUntouched(before)
  })

  it('reports a sibling-only file as absent — the healthy verdict — and writes nothing', () => {
    const before = writeAged(SIBLING_ONLY)

    expect(inspectLegacyMcpRegistration(root)).toEqual({ kind: 'absent' })
    expectUntouched(before)
  })

  it('reports a missing file and does NOT create one', () => {
    expect(inspectLegacyMcpRegistration(root)).toEqual({ kind: 'missing-file' })
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('reports valid JSON without mcpServers as unparseable, and writes nothing', () => {
    const before = writeAged(SCHEMA_ONLY)

    expect(inspectLegacyMcpRegistration(root)).toEqual({ kind: 'unparseable' })
    expectUntouched(before)
  })

  it('reports invalid JSON as unparseable, and writes nothing', () => {
    const before = writeAged('{ nope')

    expect(inspectLegacyMcpRegistration(root)).toEqual({ kind: 'unparseable' })
    expectUntouched(before)
  })

  it('reports our server under another key as wrong-key, naming the key, and writes nothing', () => {
    const before = writeAged(MISFILED)

    expect(inspectLegacyMcpRegistration(root)).toEqual({ kind: 'wrong-key', key: 'ik' })
    expectUntouched(before)
  })

  // AC7 (ii): the widened predicate reaches this caller — the dep-install launcher under a key of the
  // repo's choosing is the same failed row, and the advisory must name that key.
  it('reports the dist launcher under another key as wrong-key, naming the key, and writes nothing', () => {
    const before = writeAged(JSON.stringify({ mcpServers: { ik: DIST_LAUNCHER } }))

    expect(inspectLegacyMcpRegistration(root)).toEqual({ kind: 'wrong-key', key: 'ik' })
    expectUntouched(before)
  })

  /** Edit 8: a proxy whose args mention infra-kit is NOT a misfiled server. */
  it('does not misread an ik-mcp proxy named like us as a misfiled server', () => {
    const before = writeAged(PROXY_NAMED_LIKE_US)

    expect(inspectLegacyMcpRegistration(root)).toEqual({ kind: 'absent' })
    expectUntouched(before)
  })

  it('prefers stale over wrong-key when the infra-kit key is present beside a misfiled copy', () => {
    writeAged(
      JSON.stringify({
        mcpServers: { ik: buildServerEntry(), 'infra-kit': buildServerEntry() },
      }),
    )

    expect(inspectLegacyMcpRegistration(root)).toEqual({ kind: 'stale' })
  })

  it('reports a present-but-unreadable file as unparseable rather than absent', () => {
    // A directory where the file should be: exists, cannot be read as a file.
    fs.mkdirSync(mcpPath)

    expect(inspectLegacyMcpRegistration(root)).toEqual({ kind: 'unparseable' })
    expect(fs.statSync(mcpPath).isDirectory()).toBe(true)
  })
})

/** The "ours" predicate, positive and negative — exact fields, never a substring. */
describe('isInfraKitServerEntry', () => {
  it.each([
    ['the reference entry', buildServerEntry(), true],
    ['the reference entry without type', { command: 'infra-kit', args: ['mcp'] }, true],
    ['extra args after mcp', { command: 'infra-kit', args: ['mcp', '--verbose'] }, true],
    ['a custom path is not the bare command', { command: '/custom/infra-kit', args: ['mcp'] }, false],
    ['our command with another subcommand', { command: 'infra-kit', args: ['dev'] }, false],
    ['our command with no args', { command: 'infra-kit' }, false],
    ['a proxy whose args mention us', { command: 'ik-mcp', args: ['--name', 'infra-kit-x'] }, false],
    ['a node launcher pointing at our dist', DIST_LAUNCHER, true],
    [
      'an absolute launcher path to our dist',
      { command: 'node', args: ['/repo/node_modules/infra-kit/dist/mcp.js'] },
      true,
    ],
    [
      "a node launcher pointing at another package's mcp.js",
      { command: 'node', args: ['./node_modules/other/dist/mcp.js'] },
      false,
    ],
    [
      'a node launcher pointing at our proxy, not the server',
      { command: 'node', args: ['./node_modules/infra-kit/dist/mcp-proxy.js'] },
      false,
    ],
    ['an http server', { type: 'http', url: 'https://mcp.linear.app/mcp' }, false],
    ['not an object', 'infra-kit mcp', false],
    ['null', null, false],
  ])('%s → %s', (_label, entry, expected) => {
    expect(isInfraKitServerEntry(entry)).toBe(expected)
  })
})

describe('the module is writer-free (source guard)', () => {
  it('imports nothing that writes and never calls a write API', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'mcp-registration.ts'), 'utf-8')

    // Identifiers only: the header MAY name the retired writer to say where the server went.
    expect(source).not.toMatch(/writeFileSync|writeFile\(|mkdirSync|persist\(|createMcpFile|import \{ logger \}/)
  })
})
