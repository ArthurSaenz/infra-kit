/**
 * A release identity is either a semantic version or a free-form kebab-case
 * name. `raw` is the canonical token for the id: the no-`v` semver string for
 * versions (e.g. `1.2.3`) and the name itself for named releases.
 */
export type ReleaseId =
  | { kind: 'version'; semver: { major: number; minor: number; patch: number }; raw: string }
  | { kind: 'name'; name: string; raw: string }

/** Matches a bare or `v`-prefixed semver token, e.g. `1.2.3` or `v1.2.3`. */
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/

/** Matches the semver core after the `v` in a `release/v…` branch. */
const BRANCH_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/

/** Kebab-case: lowercase alphanumeric segments joined by single hyphens. */
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const RELEASE_BRANCH_PREFIX = 'release/'
const VERSION_BRANCH_PREFIX = 'release/v'
const NAME_BRANCH_PREFIX = 'release/n/'
const REFS_HEADS_PREFIX = 'refs/heads/'

const NEXT_TOKEN = 'next'
const MAX_NAME_LENGTH = 50

/**
 * Names that would collide with branch/release semantics or read as a special
 * token. Banned regardless of kebab-case validity.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['dev', 'main', 'next', 'hotfix', 'regular', 'release'])

/** Thrown by {@link validateName} when a release name is not acceptable. */
export class InvalidReleaseNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidReleaseNameError'
  }
}

/** Thrown by {@link parseReleaseRef} when a release ref cannot be parsed. */
export class InvalidReleaseRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidReleaseRefError'
  }
}

const stripRefsHeads = (input: string): string => {
  return input.startsWith(REFS_HEADS_PREFIX) ? input.slice(REFS_HEADS_PREFIX.length) : input
}

const makeVersion = (major: number, minor: number, patch: number): ReleaseId => {
  return {
    kind: 'version',
    semver: { major, minor, patch },
    raw: `${major}.${minor}.${patch}`,
  }
}

/**
 * Validate a release name. Throws {@link InvalidReleaseNameError} with a
 * specific message unless the name is kebab-case, at most 50 characters, and
 * not a reserved word. Semver-looking tokens (e.g. `1.2.3`) are already
 * excluded by the kebab-case rule since they contain dots.
 */
export const validateName = (name: string): void => {
  if (name.length === 0) {
    throw new InvalidReleaseNameError('Release name is empty. Provide a kebab-case name like "checkout-redesign".')
  }

  if (name.length > MAX_NAME_LENGTH) {
    throw new InvalidReleaseNameError(
      `Release name "${name}" is ${name.length} characters; the maximum is ${MAX_NAME_LENGTH}.`,
    )
  }

  if (!KEBAB_RE.test(name)) {
    throw new InvalidReleaseNameError(
      `Release name "${name}" is not kebab-case. Use lowercase letters, digits, and single hyphens, e.g. "checkout-redesign".`,
    )
  }

  if (RESERVED_NAMES.has(name)) {
    throw new InvalidReleaseNameError(
      `Release name "${name}" is reserved. Reserved names: ${[...RESERVED_NAMES].join(', ')}.`,
    )
  }
}

/**
 * Lenient parse of a git branch name into a {@link ReleaseId}. Tolerates a
 * leading `refs/heads/`. Returns `null` for anything that is not a valid
 * `release/v<semver>` or `release/n/<name>` branch. Never throws.
 */
export const parseBranchName = (branch: string): ReleaseId | null => {
  const stripped = stripRefsHeads(branch.trim())

  if (stripped.startsWith(VERSION_BRANCH_PREFIX)) {
    const semverPart = stripped.slice(VERSION_BRANCH_PREFIX.length)
    const match = BRANCH_SEMVER_RE.exec(semverPart)

    if (!match) return null

    return makeVersion(Number(match[1]), Number(match[2]), Number(match[3]))
  }

  if (stripped.startsWith(NAME_BRANCH_PREFIX)) {
    const namePart = stripped.slice(NAME_BRANCH_PREFIX.length)

    try {
      validateName(namePart)
    } catch {
      return null
    }

    return { kind: 'name', name: namePart, raw: namePart }
  }

  return null
}

/**
 * Strict parse of a release ref into a {@link ReleaseId}. Throws
 * {@link InvalidReleaseRefError} on invalid input. Precedence (order matters):
 *   1. `release/…` (or `refs/heads/release/…`) → delegate to parseBranchName.
 *   2. semver token (`1.2.3` / `v1.2.3`) → version.
 *   3. `next` → throws; callers must resolve `next` to a concrete version
 *      via computeNextVersion before calling this.
 *   4. otherwise → validateName, returning a named release.
 */
export const parseReleaseRef = (input: string): ReleaseId => {
  const trimmed = input.trim()
  const branchCandidate = stripRefsHeads(trimmed)

  if (branchCandidate.startsWith(RELEASE_BRANCH_PREFIX)) {
    const parsed = parseBranchName(trimmed)

    if (!parsed) {
      throw new InvalidReleaseRefError(
        `"${input}" looks like a release branch but is not a valid release/v<semver> or release/n/<name> ref.`,
      )
    }

    return parsed
  }

  const versionMatch = VERSION_RE.exec(trimmed)

  if (versionMatch) {
    return makeVersion(Number(versionMatch[1]), Number(versionMatch[2]), Number(versionMatch[3]))
  }

  if (trimmed.toLowerCase() === NEXT_TOKEN) {
    throw new InvalidReleaseRefError(
      'The "next" token must be resolved to a concrete version (via computeNextVersion) before parsing a release ref.',
    )
  }

  try {
    validateName(trimmed)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)

    throw new InvalidReleaseRefError(`Cannot parse "${input}" as a release ref: ${reason}`)
  }

  return { kind: 'name', name: trimmed, raw: trimmed }
}

/** Render the branch name for a release id: `release/v1.2.3` | `release/n/<name>`. */
export const formatBranchName = (id: ReleaseId): string => {
  if (id.kind === 'version') return `${VERSION_BRANCH_PREFIX}${id.raw}`

  return `${NAME_BRANCH_PREFIX}${id.name}`
}

/**
 * Render a PR title: `Release v1.2.3` / `Hotfix v1.2.3` for versions,
 * `Release <name>` / `Hotfix <name>` for names.
 */
export const formatPrTitle = (id: ReleaseId, type: 'regular' | 'hotfix'): string => {
  const prefix = type === 'hotfix' ? 'Hotfix' : 'Release'

  if (id.kind === 'version') return `${prefix} v${id.raw}`

  return `${prefix} ${id.name}`
}

/** Render a release-candidate PR title: `Release v1.2.3 (RC)` | `Release <name> (RC)`. */
export const formatRcTitle = (id: ReleaseId): string => {
  if (id.kind === 'version') return `Release v${id.raw} (RC)`

  return `Release ${id.name} (RC)`
}

/** Render the Jira fix-version name: `v1.2.3` | `<name>`. */
export const formatJiraName = (id: ReleaseId): string => {
  if (id.kind === 'version') return `v${id.raw}`

  return id.name
}

/** Render a short human display label: `1.2.3` | `<name>`. */
export const displayLabel = (id: ReleaseId): string => {
  return id.raw
}

/** True iff `branch` is a valid release branch under either scheme. */
export const isReleaseBranch = (branch: string | null | undefined): boolean => {
  if (branch === null || branch === undefined) return false

  return parseBranchName(branch) !== null
}

const toTime = (value: string | Date | undefined): number | null => {
  if (value === undefined) return null

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()

  return Number.isNaN(time) ? null : time
}

/**
 * Comparator for {@link ReleaseId} values (locked ordering):
 *   - All versions sort before all names.
 *   - Versions: semver ascending (major, then minor, then patch; numeric).
 *   - Names: by date ascending when both dates are provided, otherwise
 *     lexicographic by name. The result is stable and deterministic.
 */
export const compareReleaseIds = (
  a: ReleaseId,
  b: ReleaseId,
  dates?: { a?: string | Date; b?: string | Date },
): number => {
  if (a.kind === 'version' && b.kind === 'version') {
    if (a.semver.major !== b.semver.major) return a.semver.major - b.semver.major
    if (a.semver.minor !== b.semver.minor) return a.semver.minor - b.semver.minor

    return a.semver.patch - b.semver.patch
  }

  if (a.kind === 'version') return -1
  if (b.kind === 'version') return 1

  const timeA = toTime(dates?.a)
  const timeB = toTime(dates?.b)

  if (timeA !== null && timeB !== null && timeA !== timeB) {
    return timeA - timeB
  }

  if (a.name < b.name) return -1
  if (a.name > b.name) return 1

  return 0
}
