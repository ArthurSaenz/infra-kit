import path from 'node:path'
import process from 'node:process'

import { ENV_LOAD_FILE, INFRA_KIT_SESSION_VAR, getCacheRoot, parseVarsFromEnvFile } from 'src/lib/constants'

/**
 * Session id used when the proxy inherits none. `getSessionCacheDir()` THROWS in that case,
 * which is correct for a command and fatal for a server — a proxy that throws at startup is a
 * dead MCP server, so it degrades to a fixed dir instead.
 */
export const NO_SESSION = 'no-session'

/** Escape hatch for tests and for pointing the proxy at a hand-written file. */
export const ENV_FILE_OVERRIDE_VAR = 'IK_MCP_ENV_FILE'

/** The listed variables' values, keyed by name, in the order the spec listed them. */
export type ProxyVars = Record<string, string>

export const resolveSessionId = (): string => {
  const session = process.env[INFRA_KIT_SESSION_VAR]

  return session != null && session.length > 0 ? session : NO_SESSION
}

/**
 * Where `ik env-load` writes for this session. Goes through `getCacheRoot()` so
 * `XDG_CACHE_HOME` is honoured — a hardcoded `~/.cache` would silently read a path
 * nothing ever writes on any box that sets it.
 */
export const resolveEnvFilePath = (): string => {
  const override = process.env[ENV_FILE_OVERRIDE_VAR]

  if (override != null && override.length > 0) return override

  return path.join(getCacheRoot(), resolveSessionId(), ENV_LOAD_FILE)
}

/** The file wins over the inherited environment, per name. */
const pick = (fileVars: Record<string, string>, name: string): string => {
  const fromFile = fileVars[name]

  if (fromFile != null && fromFile.length > 0) return fromFile

  const fromEnv = process.env[name]

  return fromEnv != null && fromEnv.length > 0 ? fromEnv : ''
}

/**
 * The values of `names`, or null while any of them is missing — the normal state before
 * `ik env-load` runs, which must never be an error.
 *
 * Built by iterating `names`, not the file, so the record's key order — and therefore its
 * JSON, which is the respawn key — is stable however Doppler happens to order the file.
 */
export const readListedVars = (names: readonly string[], filePath: string = resolveEnvFilePath()): ProxyVars | null => {
  const fileVars = parseVarsFromEnvFile(filePath)
  const vars: ProxyVars = {}

  for (const name of names) {
    const value = pick(fileVars, name)

    if (value.length === 0) return null

    vars[name] = value
  }

  return vars
}

/**
 * Every name the env file defines that the spec does NOT list.
 *
 * The child inherits this process's environment, and this process was launched from a shell
 * that had normally sourced the very file these came from — so without stripping them by name,
 * every production secret reaches the child by inheritance regardless of what the spec lists.
 */
export const readUnlistedNames = (names: readonly string[], filePath: string = resolveEnvFilePath()): string[] => {
  const listed = new Set(names)

  return Object.keys(parseVarsFromEnvFile(filePath)).filter((name) => {
    return !listed.has(name)
  })
}
