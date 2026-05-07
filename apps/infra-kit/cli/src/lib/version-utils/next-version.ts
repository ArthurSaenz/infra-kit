import type { ReleaseType } from 'src/lib/release-utils'

import { parseVersion, sortVersions } from './version-utils'

export const NEXT_TOKEN = 'next'

export type SemVer = readonly [number, number, number]

export interface ExistingVersionsSources {
  remoteBranches?: string[]
  jiraVersions?: string[]
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/

const stripBranchPrefix = (raw: string): string => {
  return raw.replace(/^.*release\//, '')
}

const tryParse = (raw: string): SemVer | null => {
  const cleaned = stripBranchPrefix(raw.trim())
  const match = VERSION_RE.exec(cleaned)

  if (!match) return null

  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const semverKey = (v: SemVer): string => {
  return `${v[0]}.${v[1]}.${v[2]}`
}

export const collectKnownVersions = (sources: ExistingVersionsSources): SemVer[] => {
  const all = [...(sources.remoteBranches ?? []), ...(sources.jiraVersions ?? [])]
  const parsed: SemVer[] = []
  const seen = new Set<string>()

  for (const raw of all) {
    const v = tryParse(raw)

    if (!v) continue

    const key = semverKey(v)

    if (seen.has(key)) continue

    seen.add(key)
    parsed.push(v)
  }

  return sortVersions(
    parsed.map((v) => {
      return semverKey(v)
    }),
  ).map((s) => {
    return parseVersion(`v${s}`)
  })
}

export class NoPriorVersionsError extends Error {
  constructor() {
    super('No prior release versions found from git or Jira. Specify the version explicitly.')
    this.name = 'NoPriorVersionsError'
  }
}

/**
 * Compute the next semantic version based on release type.
 * - regular: bump minor, reset patch to 0
 * - hotfix: bump patch on the highest minor (any patch)
 *
 * Returns the version without the leading "v" (e.g. "1.64.0").
 */
export const computeNextVersion = (known: SemVer[], type: ReleaseType): string => {
  if (known.length === 0) throw new NoPriorVersionsError()

  const max = known[known.length - 1] as SemVer

  if (type === 'hotfix') {
    const [major, minor] = max

    const highestPatchOnMinor = known.reduce((acc, v) => {
      if (v[0] === major && v[1] === minor) return Math.max(acc, v[2])

      return acc
    }, 0)

    return `${major}.${minor}.${highestPatchOnMinor + 1}`
  }

  const [major, minor] = max

  return `${major}.${minor + 1}.0`
}

const isNextToken = (token: string): boolean => {
  return token.trim().toLowerCase() === NEXT_TOKEN
}

export interface ReleaseEntry {
  version: string
  type: ReleaseType
  description?: string
}

const isReleaseType = (value: string): value is ReleaseType => {
  return value === 'regular' || value === 'hotfix'
}

/**
 * Parse a CLI release spec of the form `version[:type[:description]]`.
 * Type defaults to "regular". Description is everything after the second
 * colon, so colons inside descriptions are preserved.
 */
export const parseReleaseSpec = (raw: string): ReleaseEntry => {
  const spec = raw.trim()

  if (spec === '') throw new Error('Release spec is empty')

  const firstColon = spec.indexOf(':')

  if (firstColon === -1) {
    return { version: spec, type: 'regular' }
  }

  const version = spec.slice(0, firstColon).trim()
  const rest = spec.slice(firstColon + 1)
  const secondColon = rest.indexOf(':')

  const typeRaw = secondColon === -1 ? rest.trim() : rest.slice(0, secondColon).trim()
  const description = secondColon === -1 ? '' : rest.slice(secondColon + 1).trim()
  const typeLower = typeRaw.toLowerCase()

  if (!isReleaseType(typeLower)) {
    throw new Error(`Invalid release type "${typeRaw}". Expected "regular" or "hotfix".`)
  }

  const entry: ReleaseEntry = { version, type: typeLower }

  if (description !== '') entry.description = description

  return entry
}

/**
 * Resolve a list of release entries (each with its own type and optional
 * "next" version token) into entries with concrete versions. Each "next"
 * advances based on the running max so successive "next" tokens produce
 * sequential versions, even across mixed types.
 */
export const resolveReleaseEntries = (entries: ReleaseEntry[], known: SemVer[]): ReleaseEntry[] => {
  const running: SemVer[] = [...known]

  return entries.map((entry) => {
    const trimmed = entry.version.trim()

    if (trimmed === '') {
      throw new Error('Release entry has an empty version')
    }

    if (isNextToken(trimmed)) {
      const next = computeNextVersion(running, entry.type)

      running.push(parseVersion(`v${next}`))

      return { ...entry, version: next }
    }

    const parsed = tryParse(trimmed)

    if (!parsed) {
      throw new Error(`Invalid version "${trimmed}". Expected semver like "1.2.5" or the token "next".`)
    }

    const explicit = `${parsed[0]}.${parsed[1]}.${parsed[2]}`

    running.push(parsed)

    return { ...entry, version: explicit }
  })
}

export const hasNextToken = (entries: ReleaseEntry[]): boolean => {
  return entries.some((e) => {
    return isNextToken(e.version)
  })
}
