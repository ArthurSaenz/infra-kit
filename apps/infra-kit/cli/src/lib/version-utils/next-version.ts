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

/**
 * Resolve a list of input tokens (mix of "next" and explicit semver strings)
 * into concrete version strings. Each "next" advances based on the running
 * max so "next,next" produces sequential versions.
 */
export const resolveVersionTokens = (tokens: string[], type: ReleaseType, known: SemVer[]): string[] => {
  const running: SemVer[] = [...known]
  const resolved: string[] = []

  for (const token of tokens) {
    const trimmed = token.trim()

    if (trimmed === '') continue

    if (isNextToken(trimmed)) {
      const next = computeNextVersion(running, type)

      resolved.push(next)
      running.push(parseVersion(`v${next}`))
      continue
    }

    const parsed = tryParse(trimmed)

    if (!parsed) {
      throw new Error(`Invalid version "${trimmed}". Expected semver like "1.2.5" or the token "next".`)
    }

    const explicit = `${parsed[0]}.${parsed[1]}.${parsed[2]}`

    resolved.push(explicit)
    running.push(parsed)
  }

  return resolved
}

/**
 * Split a raw user input into tokens, trimming and removing empties.
 * Accepts both whitespace-separated and comma-separated lists.
 */
export const splitVersionInput = (input: string): string[] => {
  return input
    .split(',')
    .map((t) => {
      return t.trim()
    })
    .filter(Boolean)
}
