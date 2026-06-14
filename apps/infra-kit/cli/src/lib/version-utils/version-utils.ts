/**
 * Parse a `v<semver>` token into major, minor, patch numbers.
 *
 * SemVer-ONLY: this assumes a `v<semver>` token and will produce `NaN`s for
 * anything else. Callers that may see branch names or named releases
 * (`release/n/<name>`) MUST use the `release-id` module (`parseBranchName` /
 * `parseReleaseRef` + `compareReleaseIds`) instead. Only provably names-free
 * callers (the `collectKnownVersions` / `next`-bump math path) may use this.
 */
export const parseVersion = (versionStr: string): [number, number, number] => {
  return versionStr.slice(1).split('.').map(Number) as [number, number, number]
}

/**
 * Sort version strings in ascending order.
 * Note: Returns a new sorted array without mutating the original.
 *
 * SemVer-ONLY: relies on {@link parseVersion} and will NaN-sort named releases.
 * Name-aware callers MUST use `compareReleaseIds` from the `release-id` module.
 */
export const sortVersions = (versions: string[]): string[] => {
  return [...versions].sort((a, b) => {
    const [majA, minA, patchA] = parseVersion(a)
    const [majB, minB, patchB] = parseVersion(b)

    if (majA !== majB) return (majA ?? 0) - (majB ?? 0)
    if (minA !== minB) return (minA ?? 0) - (minB ?? 0)

    return (patchA ?? 0) - (patchB ?? 0)
  })
}
