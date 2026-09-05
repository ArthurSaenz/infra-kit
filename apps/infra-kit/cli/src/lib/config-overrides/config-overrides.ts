import fs from 'node:fs/promises'

export interface OverrideSummary {
  /** True only when the layer-3 file parses AND carries at least one top-level key. */
  hasOverrides: boolean
  /** Raw top-level keys, in file order. Empty when absent, empty-object, or unreadable. */
  overrideKeys: string[]
  /** True when the file exists but could not be read or parsed as a JSON object. */
  unreadable: boolean
}

/**
 * Summarize the layer-3 user-project override file for the read-only diagnostics (`config path`,
 * `doctor`). ONE JSON-tolerance policy, shared — the two diagnostics must never disagree about what
 * a given file on disk means.
 *
 * Any read/parse failure degrades to "no overrides" plus `unreadable: true`. An empty or
 * whitespace-only file is treated as `{}`. A file that parses but is NOT a plain object
 * (`[1,2,3]`, `"x"`, `null`, `7`) is also `unreadable`.
 *
 * @example
 * await readOverrideSummary('/u/.infra-kit/projects/api/infra-kit.json', true)
 * // => { hasOverrides: true, overrideKeys: ['ide', 'dev'], unreadable: false }
 */
// RAW keys, deliberately — `Object.keys(JSON.parse(raw))`, never the config loader's `loadLayer`.
// That one throws on malformed JSON and on schema failure, and the schema object is strict, so a
// single typo'd top-level key would invalidate the whole layer and turn these diagnostic commands
// into throwers — precisely when the user reaches for them. Raw keys also surface the typo (a
// misspelled `devServersPreset` shows up in the list) instead of swallowing it.
//
// The empty-file tolerance mirrors `loadLayer`'s. A non-object cannot be a merge layer, and
// reporting an array's indices as `(3 override(s): 0, 1, 2)` would be a lie.
export const readOverrideSummary = async (filePath: string, exists: boolean): Promise<OverrideSummary> => {
  if (!exists) {
    return { hasOverrides: false, overrideKeys: [], unreadable: false }
  }

  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw)

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { hasOverrides: false, overrideKeys: [], unreadable: true }
    }

    const keys = Object.keys(parsed)

    return { hasOverrides: keys.length > 0, overrideKeys: keys, unreadable: false }
  } catch {
    return { hasOverrides: false, overrideKeys: [], unreadable: true }
  }
}

/**
 * The human-readable suffix for a layer-3 file that EXISTS. Callers own the absent case: `config
 * path` already prints a `[ ]` marker for it, while `doctor` must call it out as a possible seed
 * failure (every command seeds layer 3, so an absent file is no longer "not yet created").
 *
 * @example
 * describeOverrides({ hasOverrides: true, overrideKeys: ['ide', 'dev'], unreadable: false })
 * // => '(2 override(s): ide, dev)'
 */
export const describeOverrides = (summary: OverrideSummary): string => {
  if (summary.unreadable) {
    return '(unreadable — invalid JSON)'
  }

  if (summary.overrideKeys.length === 0) {
    return '(empty — no overrides)'
  }

  return `(${summary.overrideKeys.length} override(s): ${summary.overrideKeys.join(', ')})`
}
