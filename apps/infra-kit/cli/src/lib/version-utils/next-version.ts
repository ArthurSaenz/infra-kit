import { parseReleaseRef, validateName } from 'src/lib/release-id'
import type { ReleaseId } from 'src/lib/release-id'
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
 * A release spec is the parsed form of a versioned release request: a raw
 * version token (`"1.2.5"` or `"next"`) plus its type and optional
 * description. This is the unchanged output of {@link parseReleaseSpec} and the
 * versioned-input shape consumed by {@link resolveReleaseEntries}.
 */
export interface ReleaseSpec {
  version: string
  type: ReleaseType
  description?: string
}

/**
 * A named release request: a bare kebab-case name plus its type and optional
 * description. Named releases never auto-bump; `"next"` is version-only.
 */
export interface NamedReleaseInput {
  name: string
  type: ReleaseType
  description?: string
}

/** Either a versioned spec or a named release request. */
export type ReleaseInput = ReleaseSpec | NamedReleaseInput

/**
 * A fully resolved release entry. The {@link ReleaseId} carries the concrete
 * identity (version or name) and is the single source for branch/PR/Jira
 * formatting via the `release-id` module.
 */
export interface ReleaseEntry {
  id: ReleaseId
  type: ReleaseType
  description?: string
}

const isReleaseType = (value: string): value is ReleaseType => {
  return value === 'regular' || value === 'hotfix'
}

const isNamedReleaseInput = (input: ReleaseInput): input is NamedReleaseInput => {
  return 'name' in input
}

/**
 * Parse a CLI release spec of the form `<token>[:type[:description]]` into a
 * {@link ReleaseInput}. The token determines the kind: a semver (`"1.2.5"`) or
 * the literal `"next"` yields a versioned {@link ReleaseSpec}; anything else is
 * treated as a named release ({@link NamedReleaseInput}) — the name is not
 * validated here, {@link resolveReleaseEntries} runs `validateName` later. Type
 * defaults to "regular". Description is everything after the second colon, so
 * colons inside descriptions are preserved.
 */
export const parseReleaseSpec = (raw: string): ReleaseInput => {
  const spec = raw.trim()

  if (spec === '') throw new Error('Release spec is empty')

  const firstColon = spec.indexOf(':')
  let token = spec
  let type: ReleaseType = 'regular'
  let description = ''

  if (firstColon !== -1) {
    token = spec.slice(0, firstColon).trim()
    const rest = spec.slice(firstColon + 1)
    const secondColon = rest.indexOf(':')
    const typeRaw = secondColon === -1 ? rest.trim() : rest.slice(0, secondColon).trim()

    description = secondColon === -1 ? '' : rest.slice(secondColon + 1).trim()
    const typeLower = typeRaw.toLowerCase()

    if (!isReleaseType(typeLower)) {
      throw new Error(`Invalid release type "${typeRaw}". Expected "regular" or "hotfix".`)
    }

    type = typeLower
  }

  // A semver token or the "next" token is a versioned release; everything else
  // is a named release. parseReleaseRef applies the same precedence downstream.
  // Note: tryParse strips a leading "release/" prefix, so "release/1.2.3" reads
  // as the version 1.2.3 (a real name can never contain a slash anyway).
  if (isNextToken(token) || tryParse(token) !== null) {
    const entry: ReleaseSpec = { version: token, type }

    if (description !== '') entry.description = description

    return entry
  }

  const entry: NamedReleaseInput = { name: token, type }

  if (description !== '') entry.description = description

  return entry
}

/**
 * Render a resolved {@link ReleaseEntry} as the canonical `--release` spec that
 * reproduces it — the inverse of {@link parseReleaseSpec} composed with
 * {@link resolveReleaseEntries}. The form is minimal: the bare token when the
 * release is `regular` with no description, `token:hotfix` for a hotfix with no
 * description, and `token:type:description` whenever a description is present
 * (the type segment is required to reach the description segment). The token is
 * the resolved {@link ReleaseId.raw} — a concrete semver for versions (so a
 * resolved `"next"` pins its computed version) or the name for named releases.
 */
export const formatReleaseSpec = (entry: ReleaseEntry): string => {
  const token = entry.id.raw

  if (entry.description !== undefined && entry.description !== '') {
    return `${token}:${entry.type}:${entry.description}`
  }

  if (entry.type === 'hotfix') return `${token}:hotfix`

  return token
}

const withDescription = (base: { id: ReleaseId; type: ReleaseType }, description?: string): ReleaseEntry => {
  return description !== undefined && description !== '' ? { ...base, description } : base
}

const resolveNamedInput = (input: NamedReleaseInput): ReleaseEntry => {
  const name = input.name.trim()

  // validateName throws InvalidReleaseNameError with a specific message.
  validateName(name)

  return withDescription({ id: { kind: 'name', name, raw: name }, type: input.type }, input.description)
}

/**
 * Resolve a list of release inputs into entries carrying a concrete
 * {@link ReleaseId}. Versioned inputs use the existing spec format: the
 * `"next"` token advances based on the running max so successive `"next"`
 * tokens produce sequential versions (even across mixed types), then the
 * concrete version is wrapped in a {@link ReleaseId}. Named inputs are
 * validated via `validateName` and never auto-bump.
 */
export const resolveReleaseEntries = (entries: ReleaseInput[], known: SemVer[]): ReleaseEntry[] => {
  const running: SemVer[] = [...known]

  return entries.map((entry) => {
    if (isNamedReleaseInput(entry)) {
      return resolveNamedInput(entry)
    }

    const trimmed = entry.version.trim()

    if (trimmed === '') {
      throw new Error('Release entry has an empty version')
    }

    if (isNextToken(trimmed)) {
      const next = computeNextVersion(running, entry.type)

      running.push(parseVersion(`v${next}`))

      return withDescription({ id: parseReleaseRef(next), type: entry.type }, entry.description)
    }

    const parsed = tryParse(trimmed)

    if (!parsed) {
      throw new Error(`Invalid version "${trimmed}". Expected semver like "1.2.5" or the token "next".`)
    }

    const explicit = `${parsed[0]}.${parsed[1]}.${parsed[2]}`

    running.push(parsed)

    return withDescription({ id: parseReleaseRef(explicit), type: entry.type }, entry.description)
  })
}

export const hasNextToken = (entries: ReleaseInput[]): boolean => {
  return entries.some((e) => {
    return !isNamedReleaseInput(e) && isNextToken(e.version)
  })
}
