import fs from 'node:fs'
import path from 'node:path'

import { MARKETPLACE_NAME } from './names'

/**
 * @fileoverview
 *
 * The consumer repo's `.mcp.json` as it relates to the infra-kit server: the shared file helpers the
 * `ik-mcp` proxy writer still uses (`mcp-proxy-registration.ts`), the "this entry is ours" predicate,
 * and ONE reader — `inspectLegacyMcpRegistration`. Nothing here writes. The add-only writer that used
 * to live in this file (`ensureMcpRegistration`) is retired, and so is the server the entry pointed
 * at: the Claude Code plugin is skills-only and the skills drive the CLI over Bash
 * (`.omc/plans/mcp-to-cli-skills-migration.md`), so no repo needs an entry to have the tools.
 *
 * WHY A LEFTOVER KEY IS A CHORE, NOT A FAULT. An `infra-kit` entry spawns `infra-kit mcp`, which is an
 * unknown subcommand since 0.11.0 (the 0.10.x stderr stub is gone too) — Claude Code shows a failed
 * server row and nothing else changes. What remains is a repo PR that deletes the key by hand — a chore with no
 * deadline, which is why the verdict is `stale`, reported as a pass with an advisory, and never repaired
 * by this CLI: `.mcp.json` is hand-maintained and holds other people's servers (archived plan
 * docs/archive/mcp/mcp-via-plugin-migration-plan.md §3.4: no confirm-gated deletion).
 *
 * `wrong-key` is the same chore under another key: the same failed row under `ik`, not a different
 * fault. It is kept as its own verdict so the advisory can name the key.
 */

/** The project-scoped MCP manifest Claude Code reads, at the repo root. */
export const MCP_FILE_NAME = '.mcp.json'

/** The container key inside that file. */
export const SERVERS_KEY = 'mcpServers'

/**
 * The command, bare on purpose: consumer repos run the global install, so this is what `PATH`
 * resolves. It equals `MARKETPLACE_NAME` by coincidence of naming, not by definition — one is a
 * binary on this machine, the other is a marketplace — so it is written out rather than aliased.
 */
const SERVER_COMMAND = 'infra-kit'

/** The retired subcommand; `SERVER_COMMAND` + this is the global-install half of the "ours" predicate. */
const SERVER_ARGS: readonly string[] = ['mcp']

/** The dep-install shape (`node ./node_modules/infra-kit/dist/mcp.js`): the other half of the predicate. */
const SERVER_ENTRY_SUFFIX = '/infra-kit/dist/mcp.js'

/** Indentation for a file the proxy writer creates, and the fallback when detection finds none. */
export const DEFAULT_INDENT = '  '

export type JsonObject = Record<string, unknown>

export const isPlainObject = (value: unknown): value is JsonObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Is this server entry infra-kit's own — `command: infra-kit`, `args[0]: mcp`, or any arg ending in
 * `/infra-kit/dist/mcp.js` — whatever key it sits under?
 *
 * Exact fields, not a substring: the previous `"<command> <args>".includes('infra-kit')` read a
 * `grafana`-style proxy (`ik-mcp --name infra-kit-x …`) as a misfiled server and turned a correct
 * file into a red `wrong-key` row. The entry the CLI used to write — `{ type: 'stdio', command: 'infra-kit', args: ['mcp'] }` — is the predicate; `type` is
 * left out because Claude Code defaults it and a hand-written entry may omit it.
 *
 * @example
 * isInfraKitServerEntry({ command: 'infra-kit', args: ['mcp'] }) // => true
 * isInfraKitServerEntry({ command: 'node', args: ['./node_modules/infra-kit/dist/mcp.js'] }) // => true
 * isInfraKitServerEntry({ command: 'ik-mcp', args: ['--name', 'infra-kit-x'] }) // => false
 */
export const isInfraKitServerEntry = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false

  const { command, args } = value

  if (!Array.isArray(args)) return false
  if (command === SERVER_COMMAND && args[0] === SERVER_ARGS[0]) return true

  // A repo that pinned infra-kit as a dep registered the dist file directly, under whatever key it
  // chose; that entry is the same failed row and deserves the same advisory.
  return args.some((arg) => {
    return typeof arg === 'string' && arg.endsWith(SERVER_ENTRY_SUFFIX)
  })
}

/**
 * The file's own indent unit, taken from the first indented member line.
 *
 * Read rather than assumed so a re-serialized file differs from the original in the changed entry
 * and nothing else — a tab-indented `.mcp.json` must not come back reindented to spaces, which
 * would land as a whole-file diff in the consumer's commit.
 */
export const detectIndent = (raw: string): string => {
  const match = /\n([ \t]+)"/.exec(raw)

  return match?.[1] ?? DEFAULT_INDENT
}

/** Absent, readable, or present-but-unreadable — three states a caller must treat differently. */
export type McpFileRead = { kind: 'absent' } | { kind: 'raw'; raw: string } | { kind: 'unreadable'; error: unknown }

/**
 * Only `ENOENT` means "no file here yet".
 *
 * Every other read failure means the file EXISTS and could not be seen. A writer that collapsed that
 * into "absent" would create over a file whose siblings it never read — data loss reached through
 * the error path instead of the merge path. A write-only `.mcp.json` (mode `0o200`) is the
 * reproducer: the read fails, the write succeeds, and an unrelated server entry is gone.
 */
export const readMcpFile = (mcpPath: string): McpFileRead => {
  try {
    return { kind: 'raw', raw: fs.readFileSync(mcpPath, 'utf-8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }

    return { kind: 'unreadable', error }
  }
}

export const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export const describeError = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

/**
 * How a repo's `.mcp.json` relates to the retired infra-kit server.
 *
 * `absent` is the healthy verdict: the repo carries no entry, so nothing spawns the retired
 * subcommand. `stale` is the pending chore (a leftover key, see the file header), `wrong-key` the same chore
 * under another key. `missing-file` is `absent` for a repo with no `.mcp.json` at all. `unparseable`
 * is the one fault: the file cannot be read, so no verdict about a key is honest.
 */
export type McpRegistration =
  | { kind: 'stale' }
  | { kind: 'missing-file' }
  | { kind: 'unparseable' }
  | { kind: 'wrong-key'; key: string }
  | { kind: 'absent' }

/**
 * Read `<projectRoot>/.mcp.json` for the legacy `infra-kit` server entry. WRITES NOTHING in any branch.
 *
 * Why the KEY and not merely the server: `stale` is what every consumer repo wrote under the key the
 * old plugin used, and the advisory tells the human to delete THAT entry; a server of ours under any
 * other key is `wrong-key`, so the advisory can name the key it actually found.
 *
 * A file that is present but cannot be read, or parses to something without an `mcpServers`
 * object, is `unparseable`: the caller cannot tell whether a key is in it, and "fix the JSON" is the
 * only honest advice.
 *
 * @example
 * inspectLegacyMcpRegistration('/repo-with-leftover-key') // => { kind: 'stale' }
 * inspectLegacyMcpRegistration('/repo-on-the-plugin') // => { kind: 'absent' }
 * inspectLegacyMcpRegistration('/repo-with-ik-key') // => { kind: 'wrong-key', key: 'ik' }
 */
export const inspectLegacyMcpRegistration = (projectRoot: string): McpRegistration => {
  const read = readMcpFile(path.join(projectRoot, MCP_FILE_NAME))

  if (read.kind === 'absent') return { kind: 'missing-file' }
  if (read.kind === 'unreadable') return { kind: 'unparseable' }

  const parsed = parseJson(read.raw)

  if (!isPlainObject(parsed) || !isPlainObject(parsed[SERVERS_KEY])) return { kind: 'unparseable' }

  const servers = parsed[SERVERS_KEY]

  if (MARKETPLACE_NAME in servers) return { kind: 'stale' }

  const misfiled = Object.keys(servers).find((key) => {
    return isInfraKitServerEntry(servers[key])
  })

  return misfiled === undefined ? { kind: 'absent' } : { kind: 'wrong-key', key: misfiled }
}
