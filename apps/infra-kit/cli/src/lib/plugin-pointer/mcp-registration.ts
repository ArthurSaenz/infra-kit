import fs from 'node:fs'
import path from 'node:path'

import { logger } from 'src/lib/logger'

import { inspectMcpRegistration } from './install-state'
import { MARKETPLACE_NAME } from './names'

/**
 * @fileoverview
 *
 * The WRITER half of a consumer repo's `.mcp.json` registration, beside its reader
 * (`inspectMcpRegistration`). `initCore` calls it so a repo that has the plugin enabled also has the
 * MCP server the plugin's skills call.
 *
 * MERGE SAFETY IS THE WHOLE POINT, exactly as in `plugin-pointer.ts`: a consumer's `.mcp.json` is
 * hand-maintained and holds other people's servers. So this module ADDS one key when it is absent,
 * never overwrites an existing value, touches no sibling server, preserves key order, the file's own
 * indentation and its trailing newline, and writes nothing at all when the key is already there.
 *
 * It keys off ITS OWN `JSON.parse`, not off the reader's verdict. The reader answers `unparseable`
 * for a file whose `mcpServers` is merely missing (`install-state.ts:228`), so a perfectly valid
 * `{"$schema": "…"}` reads as unparseable there — refusing on that verdict would strand a repairable
 * file forever while `doctor` told the user to fix JSON that is fine. The reader is consulted for one
 * question only, the one it answers precisely: is one of the SIBLING keys already infra-kit's server?
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

/** Indentation for a file we create ourselves, and the fallback when detection finds none. */
export const DEFAULT_INDENT = '  '

/** What `ensureMcpRegistration` did. Only `added` and `created` wrote; the rest are all deliberate. */
export type McpRegistrationStatus = 'added' | 'created' | 'unchanged' | 'unparseable' | 'misfiled' | 'failed'

export interface McpRegistrationResult {
  status: McpRegistrationStatus
  /** The `.mcp.json` that was inspected (written only for `added` / `created`). */
  path: string
  /** The sibling key a misfiled infra-kit server sits under. Set for `misfiled`, `null` otherwise. */
  misfiledKey: string | null
}

export type JsonObject = Record<string, unknown>

/**
 * The server entry, minted fresh per call so no caller can mutate a shared constant.
 *
 * These exact three fields are what this repo's own committed `.mcp.json` carries.
 */
const buildServerEntry = (): JsonObject => {
  return { type: 'stdio', command: SERVER_COMMAND, args: ['mcp'] }
}

export const isPlainObject = (value: unknown): value is JsonObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const outcome = (
  status: McpRegistrationStatus,
  mcpPath: string,
  misfiledKey: string | null = null,
): McpRegistrationResult => {
  return { status, path: mcpPath, misfiledKey }
}

/**
 * The file's own indent unit, taken from the first indented member line.
 *
 * Read rather than assumed so the re-serialized file differs from the original in the added key and
 * nothing else — a tab-indented `.mcp.json` must not come back reindented to spaces, which would land
 * as a whole-file diff in the consumer's commit.
 */
export const detectIndent = (raw: string): string => {
  const match = /\n([ \t]+)"/.exec(raw)

  return match?.[1] ?? DEFAULT_INDENT
}

/** Absent, readable, or present-but-unreadable — three states the caller must treat differently. */
export type McpFileRead = { kind: 'absent' } | { kind: 'raw'; raw: string } | { kind: 'unreadable'; error: unknown }

/**
 * Only `ENOENT` means "no file here yet".
 *
 * Every other read failure means the file EXISTS and could not be seen, and collapsing that into
 * "absent" hands it to {@link createMcpFile}, which replaces a file whose siblings were never read —
 * pre-mortem 1's data loss reached through the error path instead of the merge path. A write-only
 * `.mcp.json` (mode `0o200`) is the reproducer: the read fails, the write succeeds, and an unrelated
 * server entry is gone with no warning.
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
 * Write, or report the failure at `warn`.
 *
 * `warn` and not `debug`: `initCore`'s caller swallows what this module throws into a `debug` line and
 * still prints its success message, so a `.mcp.json` that is a directory or is read-only would
 * otherwise fail completely invisibly. The exit code stays 0 — a failed registration is not a reason
 * to abort the rest of `initCore`.
 */
const writeFileOrWarn = (mcpPath: string, contents: string): boolean => {
  try {
    fs.writeFileSync(mcpPath, contents, 'utf-8')

    return true
  } catch (error) {
    logger.warn(
      `Could not write ${mcpPath} (${describeError(error)}) — the infra-kit MCP server is not registered. Add a "${MARKETPLACE_NAME}" entry to ${SERVERS_KEY} by hand, then re-run: infra-kit setup --skip-tools`,
    )

    return false
  }
}

/** Re-serialize a mutated document, keeping the original's indent and trailing newline. */
const persist = (mcpPath: string, parsed: JsonObject, raw: string): McpRegistrationResult => {
  const trailingNewline = raw.endsWith('\n') ? '\n' : ''
  const contents = `${JSON.stringify(parsed, null, detectIndent(raw))}${trailingNewline}`

  return writeFileOrWarn(mcpPath, contents) ? outcome('added', mcpPath) : outcome('failed', mcpPath)
}

/** Create the file with only our server — the `initCore` decision that it lands in the repo either way. */
const createMcpFile = (mcpPath: string): McpRegistrationResult => {
  const document = { [SERVERS_KEY]: { [MARKETPLACE_NAME]: buildServerEntry() } }
  const contents = `${JSON.stringify(document, null, DEFAULT_INDENT)}\n`

  fs.mkdirSync(path.dirname(mcpPath), { recursive: true })

  return writeFileOrWarn(mcpPath, contents) ? outcome('created', mcpPath) : outcome('failed', mcpPath)
}

/**
 * Is one of the sibling keys already infra-kit's server?
 *
 * Answered by the READER rather than by a second copy of its predicate, so the writer refuses in
 * exactly the cases `doctor` reports as `wrong-key` and the two can never drift apart. This is the
 * one question the reader answers precisely: `wrong-key` requires a parsed object, an absent
 * `infra-kit` key, and a sibling whose command matches — the same three facts asked for here.
 */
const findMisfiledKey = (projectRoot: string): string | null => {
  const registration = inspectMcpRegistration(projectRoot)

  return registration.kind === 'wrong-key' ? registration.key : null
}

interface RegisterInput {
  mcpPath: string
  parsed: JsonObject
  projectRoot: string
  raw: string
}

/**
 * Add the key into a document that parsed, refusing on the two states a human has to resolve.
 *
 * Refusing on a misfiled sibling costs the user one read; adding alongside it would run TWO infra-kit
 * servers while `doctor` certified `ok`, because `install-state.ts:232` short-circuits on key presence
 * before it ever looks at the siblings. Renaming their key for them is a semantic edit of something
 * they deliberately typed, so it stays theirs to make.
 */
const registerServer = ({ mcpPath, parsed, projectRoot, raw }: RegisterInput): McpRegistrationResult => {
  const servers = parsed[SERVERS_KEY]

  if (servers === undefined) {
    parsed[SERVERS_KEY] = { [MARKETPLACE_NAME]: buildServerEntry() }

    return persist(mcpPath, parsed, raw)
  }

  if (!isPlainObject(servers)) {
    logger.warn(
      `${mcpPath} has a "${SERVERS_KEY}" that is not an object — left it untouched. Fix it and re-run: infra-kit setup --skip-tools`,
    )

    return outcome('unparseable', mcpPath)
  }

  if (MARKETPLACE_NAME in servers) {
    logger.debug(`${mcpPath} already registers the "${MARKETPLACE_NAME}" server`)

    return outcome('unchanged', mcpPath)
  }

  const misfiled = findMisfiledKey(projectRoot)

  if (misfiled !== null) {
    logger.warn(
      `${mcpPath} already registers the infra-kit server under "${misfiled}" — left it untouched. Rename that key to "${MARKETPLACE_NAME}" by hand: tool names are mcp__<key>__<tool>, and a second "${MARKETPLACE_NAME}" entry beside "${misfiled}" would run two servers`,
    )

    return outcome('misfiled', mcpPath, misfiled)
  }

  servers[MARKETPLACE_NAME] = buildServerEntry()

  return persist(mcpPath, parsed, raw)
}

/**
 * Ensure `<projectRoot>/.mcp.json` registers the infra-kit MCP server under the `infra-kit` key.
 *
 * The key is not negotiable: Claude Code namespaces tools as `mcp__<key>__<tool>` and every plugin
 * skill names `mcp__infra-kit__*`, so a correct server under another key resolves nothing, silently.
 *
 * @example
 * ensureMcpRegistration('/repo')
 * // first run:  { status: 'created', path: '/repo/.mcp.json', misfiledKey: null }
 * // second run: { status: 'unchanged', … }  — no write, mtime untouched
 */
export const ensureMcpRegistration = (projectRoot: string): McpRegistrationResult => {
  const mcpPath = path.join(projectRoot, MCP_FILE_NAME)
  const read = readMcpFile(mcpPath)

  if (read.kind === 'absent') return createMcpFile(mcpPath)

  if (read.kind === 'unreadable') {
    logger.warn(
      `Could not read ${mcpPath} (${describeError(read.error)}) — left it untouched. Fix its permissions and re-run \`infra-kit setup --skip-tools\`, or add a "${MARKETPLACE_NAME}" entry to ${SERVERS_KEY} by hand.`,
    )

    return outcome('failed', mcpPath)
  }

  const { raw } = read
  const parsed = parseJson(raw)

  if (!isPlainObject(parsed)) {
    logger.warn(
      `Could not parse ${mcpPath} — left it untouched. Add a "${MARKETPLACE_NAME}" entry to ${SERVERS_KEY} by hand, or fix the JSON and re-run: infra-kit setup --skip-tools`,
    )

    return outcome('unparseable', mcpPath)
  }

  return registerServer({ mcpPath, parsed, projectRoot, raw })
}
