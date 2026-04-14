/**
 * Parse version string into major, minor, patch numbers
 */
export const parseVersion = (versionStr: string): [number, number, number] => {
  return versionStr.replace('release/', '').slice(1).split('.').map(Number) as [number, number, number]
}

/**
 * Sort version strings in ascending order
 * Note: Returns a new sorted array without mutating the original
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
