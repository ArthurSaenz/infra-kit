import fs from 'node:fs'
import path from 'node:path'

import { MARKETPLACE_NAME } from './names'

/**
 * @fileoverview
 *
 * The consumer repo's `.mcp.json` as it relates to the infra-kit server: the shared file helpers the
 * `ik-mcp` proxy writer still uses (`mcp-proxy-registration.ts`), the "this entry is ours" predicate,
 * and ONE reader — `inspectLegacyMcpRegistration`. Nothing here writes. The add-only writer that used
 * to live in this file (`ensureMcpRegistration`) is retired: the Claude Code plugin ships the server
 * itself (`plugins/infra-kit/.mcp.json`), so a repo no longer needs its own entry to have the tools.
 *
 * WHY A LEFTOVER KEY IS A CHORE, NOT A FAULT. Claude Code resolves a project-scope `.mcp.json` entry
 * and a plugin server of the same key to ONE server — the repo's entry wins, and the plugin's copy is
 * shadowed (measured, plan docs/mcp-via-plugin-migration-plan.md §6.1 S0-3). That session's tools
 * are therefore `LEGACY_MCP_TOOL_PREFIX*`, and because the server renders every body and description
 * for the route that spawned it (`src/mcp/tool-prefix.ts`), the guidance it reads names exactly the
 * tools it has. A shadowed session works end to end. What remains is a repo PR that deletes the key
 * by hand — a chore with no deadline, which is why the verdict is `stale`, reported as a pass with an
 * advisory, and never repaired by this CLI: `.mcp.json` is hand-maintained and holds other people's
 * servers (plan §3.4: no confirm-gated deletion).
 *
 * The one verdict that IS a fault is `wrong-key`: our server under another key is a SECOND server
 * process with a prefix neither constant spells, and no body the plugin serves can name its tools.
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
export const SERVER_COMMAND = 'infra-kit'

/** The subcommand that runs the server; `SERVER_COMMAND` + this is the whole "ours" predicate. */
export const SERVER_ARGS: readonly string[] = ['mcp']

/** Indentation for a file the proxy writer creates, and the fallback when detection finds none. */
export const DEFAULT_INDENT = '  '

export type JsonObject = Record<string, unknown>

/**
 * The server entry, minted fresh per call so no caller can mutate a shared constant.
 *
 * These exact three fields are what a consumer's committed `.mcp.json` carried while the CLI wrote
 * it, and what the plugin's own `.mcp.json` carries now; nothing writes it any more — it is kept as
 * the reference shape {@link isInfraKitServerEntry} is the predicate of.
 *
 * @example
 * buildServerEntry() // => { type: 'stdio', command: 'infra-kit', args: ['mcp'] }
 */
export const buildServerEntry = (): JsonObject => {
  return { type: 'stdio', command: SERVER_COMMAND, args: [...SERVER_ARGS] }
}

export const isPlainObject = (value: unknown): value is JsonObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Is this server entry infra-kit's own — `command: infra-kit`, `args[0]: mcp` — whatever key it sits
 * under?
 *
 * Exact fields, not a substring: the previous `"<command> <args>".includes('infra-kit')` read a
 * `grafana`-style proxy (`ik-mcp --name infra-kit-x …`) as a misfiled server and turned a correct
 * file into a red `wrong-key` row. The {@link buildServerEntry} shape is the predicate; `type` is
 * left out because Claude Code defaults it and a hand-written entry may omit it.
 *
 * @example
 * isInfraKitServerEntry({ command: 'infra-kit', args: ['mcp'] }) // => true
 * isInfraKitServerEntry({ command: 'ik-mcp', args: ['--name', 'infra-kit-x'] }) // => false
 */
export const isInfraKitServerEntry = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false

  const { command, args } = value

  return command === SERVER_COMMAND && Array.isArray(args) && args[0] === SERVER_ARGS[0]
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
 * How a repo's `.mcp.json` relates to the infra-kit server.
 *
 * `absent` is the healthy verdict: the plugin serves the server, and the repo carries no entry to
 * shadow it. `stale` is the pending chore (a leftover key, see the file header). `missing-file` is
 * `absent` for a repo with no `.mcp.json` at all. `wrong-key` and `unparseable` are the two faults.
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
 * Why the KEY and not merely the server: Claude Code namespaces a project-scope server's tools by
 * its key, and the plugin's server is keyed `infra-kit` — so an entry under that key shadows the
 * plugin's (a working session on the legacy route, `stale`), while our server under `ik` is a
 * SECOND server whose tools no served body names (`wrong-key`).
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
