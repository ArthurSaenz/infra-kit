// The cmux → orca cutover renamed three config keys and kept the schema `.strict()` (a dual
// vocabulary across shallow-merged layers is worse than a parse-time refusal — see the migration
// plan). But `getInfraKitConfig` guards nearly every command, and the CLI self-updates, so a refusal
// would arrive unannounced and brick the machine until `infra-kit setup` ran. These two pure helpers
// are the bridge: `stripLegacyCmuxKeys` keeps the loader parsing (in memory, never written), and
// `renameCmuxKeys` is what the setup migration writes back. Remove one release after ship.

const LEGACY_OPEN_IN_CMUX = 'openInCmux'
const LEGACY_CMUX = 'cmux'
const OPEN_IN_ORCA = 'openInOrca'
const ORCA = 'orca'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const omitKeys = (record: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => {
      return !keys.includes(key)
    }),
  )
}

/**
 * Remove exactly the three legacy cmux key paths (`worktrees.openInCmux`, `worktrees.cmux`,
 * `devServersPresets.<any>.cmux`) from a parsed config layer so the strict schema accepts it.
 * Pure; returns the SAME reference when nothing was stripped so callers can skip work by identity.
 *
 * @example
 * stripLegacyCmuxKeys({ worktrees: { openInCmux: true, openInGithubDesktop: false } })
 * // => { stripped: ['worktrees.openInCmux'], result: { worktrees: { openInGithubDesktop: false } } }
 * stripLegacyCmuxKeys({ worktrees: {} }) // => { stripped: [], result: <same reference> }
 */
export const stripLegacyCmuxKeys = (raw: unknown): { stripped: string[]; result: unknown } => {
  if (!isRecord(raw)) return { stripped: [], result: raw }

  const stripped: string[] = []
  let result = raw

  const worktrees = raw.worktrees

  if (isRecord(worktrees)) {
    const legacy = [LEGACY_OPEN_IN_CMUX, LEGACY_CMUX].filter((key) => {
      return key in worktrees
    })

    if (legacy.length > 0) {
      stripped.push(
        ...legacy.map((key) => {
          return `worktrees.${key}`
        }),
      )
      result = { ...result, worktrees: omitKeys(worktrees, legacy) }
    }
  }

  const presets = raw.devServersPresets

  if (isRecord(presets)) {
    let nextPresets = presets

    for (const [name, preset] of Object.entries(presets)) {
      if (!isRecord(preset) || !(LEGACY_CMUX in preset)) continue

      stripped.push(`devServersPresets.${name}.${LEGACY_CMUX}`)
      nextPresets = { ...nextPresets, [name]: omitKeys(preset, [LEGACY_CMUX]) }
    }

    if (nextPresets !== presets) {
      result = { ...result, devServersPresets: nextPresets }
    }
  }

  return { stripped, result }
}

/**
 * Rename one legacy key to its orca name in place (key order preserved, so the rewritten file
 * diffs as a one-line rename). When BOTH names are present the new key wins and the legacy one is
 * dropped: the user already migrated by hand, and a stale legacy value must not overwrite it.
 */
const renameKey = (
  record: Record<string, unknown>,
  from: string,
  to: string,
): { changed: boolean; result: Record<string, unknown> } => {
  if (!(from in record)) return { changed: false, result: record }

  const keepExisting = to in record

  const result = Object.fromEntries(
    Object.entries(record).flatMap(([key, value]): [string, unknown][] => {
      if (key !== from) return [[key, value]]

      return keepExisting ? [] : [[to, value]]
    }),
  )

  return { changed: true, result }
}

/**
 * Rewrite the three legacy cmux key paths to their orca names: `worktrees.openInCmux` →
 * `worktrees.openInOrca`, `worktrees.cmux` → `worktrees.orca`, `devServersPresets.<k>.cmux` →
 * `devServersPresets.<k>.orca`. Every other key is preserved verbatim (no schema validation), and
 * the SAME reference comes back when nothing changed so the migration can skip the file write.
 *
 * @example
 * renameCmuxKeys({ worktrees: { openInCmux: true } })
 * // => { changed: true, result: { worktrees: { openInOrca: true } } }
 * renameCmuxKeys({ worktrees: { openInOrca: true } }) // => { changed: false, result: <same reference> }
 */
export const renameCmuxKeys = (parsed: unknown): { changed: boolean; result: unknown } => {
  if (!isRecord(parsed)) return { changed: false, result: parsed }

  let changed = false
  let result = parsed

  const worktrees = parsed.worktrees

  if (isRecord(worktrees)) {
    const openIn = renameKey(worktrees, LEGACY_OPEN_IN_CMUX, OPEN_IN_ORCA)
    const layout = renameKey(openIn.result, LEGACY_CMUX, ORCA)

    if (openIn.changed || layout.changed) {
      changed = true
      result = { ...result, worktrees: layout.result }
    }
  }

  const presets = parsed.devServersPresets

  if (isRecord(presets)) {
    let nextPresets = presets

    for (const [name, preset] of Object.entries(presets)) {
      if (!isRecord(preset)) continue

      const renamed = renameKey(preset, LEGACY_CMUX, ORCA)

      if (!renamed.changed) continue

      nextPresets = { ...nextPresets, [name]: renamed.result }
    }

    if (nextPresets !== presets) {
      changed = true
      result = { ...result, devServersPresets: nextPresets }
    }
  }

  return { changed, result }
}
