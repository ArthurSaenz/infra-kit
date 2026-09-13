import fs from 'node:fs'
import path from 'node:path'

import type { McpProxies } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { IK_MCP_COMMAND, deriveMcpEntry } from 'src/lib/mcp-proxy/derive'
import type { DerivedMcpEntry } from 'src/lib/mcp-proxy/derive'

import {
  DEFAULT_INDENT,
  MCP_FILE_NAME,
  SERVERS_KEY,
  describeError,
  detectIndent,
  isPlainObject,
  parseJson,
  readMcpFile,
} from './mcp-registration'
import type { JsonObject } from './mcp-registration'

/**
 * @fileoverview
 *
 * The `ik-mcp` half of `.mcp.json`: one entry per `mcp.<name>` in the project `infra-kit.json`,
 * derived by {@link deriveMcpEntry}, beside the add-only `infra-kit` key `mcp-registration.ts` owns.
 *
 * The contract FORKS BY OWNERSHIP, and the fork is the whole design:
 *   - an entry under a configured name whose `command` is `ik-mcp` is ours to REWRITE — config is
 *     authoritative for that name, so a differing argv is drift by definition;
 *   - an entry whose `command` is `ik-mcp` under a name NOT in config is REPORTED, never removed —
 *     the command proves config owns the name, not that `ik` wrote the entry (a developer trying a
 *     fork hand-writes exactly this), and "invalid config → empty derived set" composed with removal
 *     would delete every entry on a typo in an unrelated key;
 *   - a foreign entry under a configured name is a CONFLICT, refused rather than clobbered;
 *   - every other entry is never touched.
 * `--fix` writes only what it can regenerate. It deletes nothing.
 */

export type ProxyEntryStatus = 'written' | 'unchanged' | 'drifted' | 'stale' | 'conflict'

export interface ProxyEntryReport {
  name: string
  status: ProxyEntryStatus
  /** Human text with the manual fix spelled out; empty for `written` / `unchanged`. */
  message: string
}

export type McpProxyReconcileStatus = 'ok' | 'unreadable' | 'unparseable' | 'failed'

export interface McpProxyReconcileResult {
  status: McpProxyReconcileStatus
  path: string
  entries: ProxyEntryReport[]
  wrote: boolean
}

export interface ReconcileInput {
  projectRoot: string
  /** The parsed, validated `mcp` block. Callers pass NOTHING when config is absent or invalid. */
  proxies: McpProxies
  /** Rewrite drifted owned entries and add missing ones; otherwise report only. */
  write: boolean
}

const SETUP_HINT = 'run `infra-kit setup` (or `infra-kit audit --root --fix`)'

const sameArgs = (a: unknown, b: string[]): boolean => {
  return (
    Array.isArray(a) &&
    a.length === b.length &&
    a.every((item, i) => {
      return item === b[i]
    })
  )
}

const isOwned = (entry: unknown): entry is JsonObject => {
  return isPlainObject(entry) && entry.command === IK_MCP_COMMAND
}

/** Rewrite only the three derived fields, keeping anything else Claude Code accepts (`env`, …). */
const applyDerived = (existing: JsonObject | undefined, derived: DerivedMcpEntry): JsonObject => {
  return { ...(existing ?? {}), type: derived.type, command: derived.command, args: derived.args }
}

interface Reconciliation {
  entries: ProxyEntryReport[]
  /** The servers object after applying every permitted change (untouched when nothing is permitted). */
  servers: JsonObject
  changed: boolean
}

const reconcileServers = (servers: JsonObject, proxies: McpProxies, write: boolean): Reconciliation => {
  const entries: ProxyEntryReport[] = []
  const next: JsonObject = { ...servers }
  let changed = false

  for (const [name, spec] of Object.entries(proxies)) {
    const derived = deriveMcpEntry(name, spec)
    const existing = servers[name]

    if (existing !== undefined && !isOwned(existing)) {
      entries.push({
        name,
        status: 'conflict',
        message: `"${name}" is configured under mcp but .mcp.json already has a hand-written "${name}" server that is not ik-mcp — left it untouched. Remove that entry (or rename it) and ${SETUP_HINT}, or drop mcp.${name} from infra-kit.json`,
      })
      continue
    }

    if (isOwned(existing) && existing.type === derived.type && sameArgs(existing.args, derived.args)) {
      entries.push({ name, status: 'unchanged', message: '' })
      continue
    }

    if (write) {
      next[name] = applyDerived(existing, derived)
      changed = true
      entries.push({ name, status: 'written', message: '' })
      continue
    }

    entries.push({
      name,
      status: 'drifted',
      message:
        existing === undefined
          ? `"${name}" is configured under mcp but has no .mcp.json entry — ${SETUP_HINT}`
          : `"${name}" in .mcp.json does not match its mcp.${name} config — ${SETUP_HINT}`,
    })
  }

  for (const [name, entry] of Object.entries(servers)) {
    // `hasOwn`, not `in`: a hand-written entry named `constructor` must not vanish into the prototype.
    if (Object.hasOwn(proxies, name) || !isOwned(entry)) continue

    // Reported, never removed: see the fileoverview.
    entries.push({
      name,
      status: 'stale',
      message: `"${name}" runs ik-mcp but there is no mcp.${name} in infra-kit.json — add it, or remove the entry: claude mcp remove ${name} --scope project`,
    })
  }

  return { entries, servers: next, changed }
}

const persist = (mcpPath: string, document: JsonObject, raw: string | null): boolean => {
  const indent = raw === null ? DEFAULT_INDENT : detectIndent(raw)
  const trailingNewline = raw === null || raw.endsWith('\n') ? '\n' : ''

  try {
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
    fs.writeFileSync(mcpPath, `${JSON.stringify(document, null, indent)}${trailingNewline}`, 'utf-8')

    return true
  } catch (error) {
    logger.warn(`Could not write ${mcpPath} (${describeError(error)}) — the ik-mcp entries were not updated.`)

    return false
  }
}

/**
 * Bring the `ik-mcp` entries of `<projectRoot>/.mcp.json` in line with `proxies`.
 *
 * @example
 * reconcileMcpProxies({ projectRoot: '/repo', proxies, write: false })
 * // => { status: 'ok', entries: [{ name: 'grafana', status: 'drifted', message: '…' }], wrote: false }
 */
export const reconcileMcpProxies = ({ projectRoot, proxies, write }: ReconcileInput): McpProxyReconcileResult => {
  const mcpPath = path.join(projectRoot, MCP_FILE_NAME)
  const read = readMcpFile(mcpPath)

  if (read.kind === 'unreadable') {
    logger.warn(`Could not read ${mcpPath} (${describeError(read.error)}) — left it untouched.`)

    return { status: 'unreadable', path: mcpPath, entries: [], wrote: false }
  }

  const raw = read.kind === 'raw' ? read.raw : null
  const document: unknown = raw === null ? {} : parseJson(raw)

  if (!isPlainObject(document)) {
    logger.warn(`Could not parse ${mcpPath} — left it untouched. Fix the JSON, then ${SETUP_HINT}.`)

    return { status: 'unparseable', path: mcpPath, entries: [], wrote: false }
  }

  const servers = document[SERVERS_KEY]

  if (servers !== undefined && !isPlainObject(servers)) {
    logger.warn(`${mcpPath} has a "${SERVERS_KEY}" that is not an object — left it untouched.`)

    return { status: 'unparseable', path: mcpPath, entries: [], wrote: false }
  }

  const result = reconcileServers(servers ?? {}, proxies, write)

  if (!result.changed) return { status: 'ok', path: mcpPath, entries: result.entries, wrote: false }

  const wrote = persist(mcpPath, { ...document, [SERVERS_KEY]: result.servers }, raw)

  return { status: wrote ? 'ok' : 'failed', path: mcpPath, entries: result.entries, wrote }
}
