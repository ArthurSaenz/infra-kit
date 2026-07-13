/**
 * Registry-safe version comparison for the auto-update check.
 *
 * Deliberately NOT `src/lib/version-utils`: `parseVersion` there does `versionStr.slice(1)` because it
 * only ever sees `v`-prefixed release tags, so it turns a bare registry version (`0.1.130`) into
 * `[NaN, 1, 130]`. Feeding npm's `dist-tags.latest` through it silently compares NaNs and never fires.
 * These inputs are bare semver from `registry.npmjs.org` and from our own `package.json`.
 */

/** `1.2.3-beta.4+build` → the `[1, 2, 3]` release triple and the `beta.4` prerelease, or null if unparsable. */
interface ParsedVersion {
  release: [number, number, number]
  /** Dot-separated prerelease identifiers, empty when this is a final release. */
  prerelease: string[]
}

const RELEASE_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * Parse bare semver. Returns null (never throws, never NaNs) for anything that is not
 * `major.minor.patch` with optional `-prerelease` and `+build` — a garbled registry body must read as
 * "no update", not as "update to NaN".
 *
 * @example
 * parseSemver('0.1.130') // => { release: [0, 1, 130], prerelease: [] }
 * parseSemver('1.0.0-rc.1+abc') // => { release: [1, 0, 0], prerelease: ['rc', '1'] }
 * parseSemver('v1.0.0') // => null
 */
export const parseSemver = (version: string): ParsedVersion | null => {
  // Build metadata is ignored entirely by semver precedence rules.
  const [withoutBuild = ''] = version.trim().split('+')
  const [core = '', ...prereleaseParts] = withoutBuild.split('-')
  const match = RELEASE_PATTERN.exec(core)

  if (!match) return null

  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [number, number, number]

  return {
    release: [major, minor, patch],
    // Re-join on '-' so `1.0.0-rc-1` keeps its hyphen inside a single identifier.
    prerelease: prereleaseParts.length > 0 ? prereleaseParts.join('-').split('.') : [],
  }
}

const NUMERIC_IDENTIFIER = /^\d+$/

/** Compare two unequal prerelease identifiers per semver §11. Numeric ones rank below alphanumeric ones. */
const compareIdentifier = (left: string, right: string): number => {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left)
  const rightNumeric = NUMERIC_IDENTIFIER.test(right)

  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1

  return left < right ? -1 : 1
}

/** Compare prerelease identifier lists. A shorter list has lower precedence: `1.0.0-rc` < `1.0.0-rc.1`. */
const comparePrerelease = (a: string[], b: string[]): number => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]

    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left !== right) return compareIdentifier(left, right)
  }

  return 0
}

/**
 * Is `latest` strictly newer than `current`? False when either is unparsable, so a bad registry
 * response can never trigger an install.
 *
 * The load-bearing case is NUMERIC, not lexical, comparison: `0.1.9` must be older than `0.1.130`.
 * A string compare would order them the other way and pin every user to the older build forever.
 *
 * A final release outranks its own prereleases (`1.0.0` > `1.0.0-rc.1`), so a user on `rc` is offered
 * the release, and a user on the release is never "downgraded" to an rc.
 *
 * @example
 * isNewerVersion('0.1.130', '0.1.9') // => true  (numeric, not lexical)
 * isNewerVersion('1.0.0', '1.0.0-rc.1') // => true
 * isNewerVersion('0.1.130', '0.1.130') // => false
 * isNewerVersion('garbage', '0.1.0') // => false
 */
export const isNewerVersion = (latest: string, current: string): boolean => {
  const parsedLatest = parseSemver(latest)
  const parsedCurrent = parseSemver(current)

  if (!parsedLatest || !parsedCurrent) return false

  for (let index = 0; index < 3; index += 1) {
    const left = parsedLatest.release[index] as number
    const right = parsedCurrent.release[index] as number

    if (left !== right) return left > right
  }

  const latestIsFinal = parsedLatest.prerelease.length === 0
  const currentIsFinal = parsedCurrent.prerelease.length === 0

  if (latestIsFinal !== currentIsFinal) return latestIsFinal

  return comparePrerelease(parsedLatest.prerelease, parsedCurrent.prerelease) > 0
}
