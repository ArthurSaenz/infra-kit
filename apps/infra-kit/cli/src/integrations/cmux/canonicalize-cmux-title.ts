/** Matches a `v`-prefixed semver token (e.g. `v1.48.0`) anchored on shape. */
const V_SEMVER_TOKEN_RE = /\bv(\d+\.\d+\.\d+)\b/g

/**
 * Canonicalizes a cmux workspace title into a stable dedup/close key.
 *
 * cmux workspace titles are human display strings built by
 * `buildCmuxWorkspaceTitle`, so the value stored when a workspace is created can
 * drift from the value rebuilt later — across whitespace and across CLI versions
 * (an older build titled version releases `v1.48.0`; the current build titles
 * them `1.48.0`). Keying dedup or close on the raw title silently creates
 * duplicate / unclosable workspaces whenever that drift occurs.
 *
 * Canonicalization collapses the known drift axes so both sides round-trip to an
 * equal key:
 *   - trims and collapses internal whitespace to single spaces;
 *   - normalizes a `v`-prefixed semver token to its bare form
 *     (`v1.48.0` → `1.48.0`), anchored on semver shape so named releases that
 *     merely start with `v` (e.g. `vega-redesign`) are left untouched.
 *
 * Non-release fallback titles (which may contain `/`, e.g. `feature/foo`) are
 * preserved as-is apart from whitespace normalization.
 *
 * @example
 * canonicalizeCmuxTitle('hulyo-monorepo  v1.48.0')      // => 'hulyo-monorepo 1.48.0'
 * canonicalizeCmuxTitle('hulyo-monorepo 1.48.0')        // => 'hulyo-monorepo 1.48.0'
 * canonicalizeCmuxTitle('hulyo-monorepo vega-redesign') // => 'hulyo-monorepo vega-redesign'
 */
export const canonicalizeCmuxTitle = (raw: string): string => {
  return raw.trim().replace(/\s+/g, ' ').replace(V_SEMVER_TOKEN_RE, '$1')
}
