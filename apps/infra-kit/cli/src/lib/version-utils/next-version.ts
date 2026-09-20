import { assertIsoDate } from 'src/lib/release-date'
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

/**
 * {@link computeNextVersion} for callers that only want to SUGGEST a version: no prior versions
 * reads as `null` rather than a throw. Any other error is a defect and is rethrown.
 *
 * @example
 * suggestNextVersion([[1, 63, 2]], 'regular') // => '1.64.0'
 * suggestNextVersion([], 'regular')           // => null
 */
export const suggestNextVersion = (known: SemVer[], type: ReleaseType): string | null => {
  try {
    return computeNextVersion(known, type)
  } catch (err) {
    if (err instanceof NoPriorVersionsError) return null

    throw err
  }
}

const isNextToken = (token: string): boolean => {
  return token.trim().toLowerCase() === NEXT_TOKEN
}

/**
 * Sort a raw release token into the versioned or the named half of a {@link ReleaseInput} — the ONE
 * place that rule lives, shared by the `--release` flag and the argument form.
 *
 * The token is returned AS TYPED: `resolveReleaseEntries` normalises a `v` prefix downstream, and
 * `tryParse` already strips a leading `release/`, so `release/1.2.3` reads as the version 1.2.3 (a
 * real name can never contain a slash anyway). A name is NOT validated here — `validateName` runs
 * in `resolveReleaseEntries`, where the refusal can name the rule.
 *
 * @example
 * classifyReleaseToken('v1.63.3')  // => { version: 'v1.63.3' }
 * classifyReleaseToken('NEXT')     // => { version: 'NEXT' }
 * classifyReleaseToken('checkout') // => { name: 'checkout' }
 */
export const classifyReleaseToken = (token: string): { version: string } | { name: string } => {
  if (isNextToken(token) || tryParse(token) !== null) return { version: token }

  return { name: token }
}

/**
 * A release spec is the parsed form of a versioned release request: a raw
 * version token (`"1.2.5"` or `"next"`) plus its type, optional description and
 * optional planned release date (`yyyy-mm-dd`). This is the unchanged output of
 * {@link parseReleaseSpec} and the versioned-input shape consumed by
 * {@link resolveReleaseEntries}.
 */
export interface ReleaseSpec {
  version: string
  type: ReleaseType
  description?: string
  releaseDate?: string
}

/**
 * A named release request: a bare kebab-case name plus its type, optional
 * description and optional release date. Named releases never auto-bump;
 * `"next"` is version-only.
 */
export interface NamedReleaseInput {
  name: string
  type: ReleaseType
  description?: string
  releaseDate?: string
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
  releaseDate?: string
}

const isReleaseType = (value: string): value is ReleaseType => {
  return value === 'regular' || value === 'hotfix'
}

const isNamedReleaseInput = (input: ReleaseInput): input is NamedReleaseInput => {
  return 'name' in input
}

/**
 * Split the first colon-segment of a spec into its token and optional `@date`.
 *
 * Sound only while `@` is illegal in every token form — `VERSION_RE`, the literal `next`, and
 * `validateName`'s kebab-case rule (`release-id.ts`) all exclude it — so the first `@` can only be
 * the date separator. Any future token grammar must keep `@` out.
 */
const splitTokenAndDate = (segment: string): { token: string; releaseDate?: string } => {
  const at = segment.indexOf('@')

  if (at === -1) return { token: segment.trim() }

  const token = segment.slice(0, at).trim()
  const dateRaw = segment.slice(at + 1)

  if (dateRaw.includes('@')) {
    throw new Error(`Release spec "${segment}" has more than one "@". Expected "<token>@yyyy-mm-dd".`)
  }

  if (dateRaw.trim() === '') {
    throw new Error(`Release spec "${segment}" has an empty release date after "@". Expected "<token>@yyyy-mm-dd".`)
  }

  return { token, releaseDate: assertIsoDate(dateRaw) }
}

/**
 * Parse a CLI release spec of the form `<token>[@yyyy-mm-dd][:type[:description]]`
 * into a {@link ReleaseInput}.
 *
 * The token determines the kind: a semver (`"1.2.5"`) or the literal `"next"`
 * yields a versioned {@link ReleaseSpec}; anything else is treated as a named
 * release ({@link NamedReleaseInput}) — the name is not validated here,
 * {@link resolveReleaseEntries} runs `validateName` later. The `@date` split is
 * only on the first colon-segment (see {@link splitTokenAndDate} for the grammar
 * invariant it rests on). Type defaults to "regular". Description is everything
 * after the second colon, so colons inside descriptions are preserved and a
 * description that starts with a date is still a description.
 */
export const parseReleaseSpec = (raw: string): ReleaseInput => {
  const spec = raw.trim()

  if (spec === '') throw new Error('Release spec is empty')

  const firstColon = spec.indexOf(':')
  const { token, releaseDate } = splitTokenAndDate(firstColon === -1 ? spec : spec.slice(0, firstColon))
  let type: ReleaseType = 'regular'
  let description = ''

  if (firstColon !== -1) {
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

  return withOptionalFields({ ...classifyReleaseToken(token), type }, { description, releaseDate })
}

/**
 * Render a resolved {@link ReleaseEntry} as the canonical `--release` spec that
 * reproduces it — the inverse of {@link parseReleaseSpec} composed with
 * {@link resolveReleaseEntries}.
 *
 * The form is minimal: the bare token when the release is `regular` with no
 * description, `token:hotfix` for a hotfix with no description, and
 * `token:type:description` whenever a description is present (the type segment
 * is required to reach the description segment); a release date rides on the
 * token as `token@yyyy-mm-dd` and never forces a type segment
 * (`1.2.5@2026-10-28:regular` formats as `1.2.5@2026-10-28`). The token is the
 * resolved {@link ReleaseId.raw} — a concrete semver for versions (so a resolved
 * `"next"` pins its computed version) or the name for named releases.
 */
export const formatReleaseSpec = (entry: ReleaseEntry): string => {
  const token = entry.releaseDate === undefined ? entry.id.raw : `${entry.id.raw}@${entry.releaseDate}`

  if (entry.description !== undefined && entry.description !== '') {
    return `${token}:${entry.type}:${entry.description}`
  }

  if (entry.type === 'hotfix') return `${token}:hotfix`

  return token
}

interface OptionalReleaseFields {
  description?: string
  releaseDate?: string
}

// Conditional spreads, never `key: undefined`: downstream tests assert the objects exactly, and the
// agent form's round-1 arguments must equal what round 2 parses.
const withOptionalFields = <T extends object>(base: T, fields: OptionalReleaseFields): T & OptionalReleaseFields => {
  const { description, releaseDate } = fields

  return {
    ...base,
    ...(description !== undefined && description !== '' ? { description } : {}),
    ...(releaseDate === undefined ? {} : { releaseDate }),
  }
}

const resolveNamedInput = (input: NamedReleaseInput): ReleaseEntry => {
  const name = input.name.trim()

  // validateName throws InvalidReleaseNameError with a specific message.
  validateName(name)

  return withOptionalFields({ id: { kind: 'name', name, raw: name }, type: input.type }, input)
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

      return withOptionalFields({ id: parseReleaseRef(next), type: entry.type }, entry)
    }

    const parsed = tryParse(trimmed)

    if (!parsed) {
      throw new Error(`Invalid version "${trimmed}". Expected semver like "1.2.5" or the token "next".`)
    }

    const explicit = `${parsed[0]}.${parsed[1]}.${parsed[2]}`

    running.push(parsed)

    return withOptionalFields({ id: parseReleaseRef(explicit), type: entry.type }, entry)
  })
}

export const hasNextToken = (entries: ReleaseInput[]): boolean => {
  return entries.some((e) => {
    return !isNamedReleaseInput(e) && isNextToken(e.version)
  })
}
