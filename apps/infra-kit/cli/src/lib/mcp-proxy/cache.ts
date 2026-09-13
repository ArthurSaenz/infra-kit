import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { atomicWriteFileSync, getCacheRoot } from 'src/lib/constants'

/**
 * What a session can answer with before any child exists: the tool list and the
 * capability payload the upstream last reported.
 *
 * Capabilities are cached alongside the tools because MCP has no
 * capability-change notification — a deferred `initialize` must state them up front
 * and can never correct itself, so the honest answer has to come from disk.
 */
export interface UpstreamProfile {
  version: string
  protocolVersion: string
  capabilities: unknown
  tools: unknown[]
}

/**
 * Proxy state lives under the CACHE root, never `~/.infra-kit` — that is
 * `USER_CONFIG_DIR_NAME`, the auto-seeded project-config registry, where a
 * throwaway derived file has no business living. One subdir per configured name.
 */
export const proxyCacheDir = (name: string): string => {
  return path.join(getCacheRoot(), 'mcp-proxy', name)
}

/** Keeps a version string usable as one path segment. */
const safeSegment = (version: string): string => {
  return version.replaceAll(/[^\w.-]/g, '_').slice(0, 64)
}

export const profilePath = (version: string, dir: string): string => {
  return path.join(dir, `profile-${safeSegment(version)}.json`)
}

/**
 * A cache key for a binary that does not answer `--version`: its resolved path's size and mtime.
 *
 * Both change on every upgrade, which is all the key has to guarantee. Hashing the file would too,
 * but a Go binary is tens of megabytes and this runs at session start.
 */
export const binaryFingerprint = (binary: string, searchPath?: string): string => {
  const candidates = path.isAbsolute(binary)
    ? [binary]
    : (searchPath ?? process.env.PATH ?? '').split(path.delimiter).map((dir) => {
        return path.join(dir, binary)
      })

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate)

      return `stat-${stat.size}-${Math.trunc(stat.mtimeMs)}`
    } catch {
      // not here; try the next PATH entry
    }
  }

  return 'unknown'
}

/**
 * The upstream binary's self-reported version, falling back to {@link binaryFingerprint}.
 * This is the cache key, so an upgrade that changes the tool set can never be served
 * a stale list — the new version simply looks at a different file.
 */
export const readBinaryVersion = (
  binary: string,
  versionArgs: readonly string[] = ['--version'],
  searchPath?: string,
): string => {
  try {
    // The same PATH the upstream spawn uses. Without it, a `go install` layout — where
    // mcp-grafana lives only in GOBIN — probes as ENOENT, every version collapses into
    // one 'unknown' cache bucket, and an upgrade is served the previous tool list.
    const result = spawnSync(binary, [...versionArgs], {
      encoding: 'utf8',
      timeout: 5000,
      env: searchPath == null ? process.env : { ...process.env, PATH: searchPath },
    })

    if (result.status !== 0) return binaryFingerprint(binary, searchPath)

    const reported = `${result.stdout}`.trim().split('\n')[0]?.trim() ?? ''

    return reported.length > 0 ? reported : binaryFingerprint(binary, searchPath)
  } catch {
    return binaryFingerprint(binary, searchPath)
  }
}

/**
 * The cached profile for this binary version, or null.
 *
 * Every failure is a null, never a throw: a torn or truncated file must degrade to
 * "no cache yet", because the alternative is an exception on the deferred
 * `initialize` path — which would kill the session the cache exists to rescue.
 */
export const readProfile = (version: string, dir: string): UpstreamProfile | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath(version, dir), 'utf8')) as Partial<UpstreamProfile>

    if (parsed.version !== version || !Array.isArray(parsed.tools)) return null

    return {
      version,
      protocolVersion: typeof parsed.protocolVersion === 'string' ? parsed.protocolVersion : '',
      capabilities: parsed.capabilities ?? {},
      tools: parsed.tools,
    }
  } catch {
    return null
  }
}

/**
 * Persist a profile. Best-effort: a cache that cannot be written is a slower next
 * session, not a broken one.
 */
export const writeProfile = (profile: UpstreamProfile, dir: string): boolean => {
  try {
    fs.mkdirSync(dir, { recursive: true })
    // Atomic, because two sessions can write this concurrently and a half-written
    // file reads back as "no tools" — a silently toolless session with no error.
    atomicWriteFileSync(profilePath(profile.version, dir), `${JSON.stringify(profile)}\n`, 0o600)

    return true
  } catch {
    return false
  }
}
