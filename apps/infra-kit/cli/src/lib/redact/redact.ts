/**
 * The single redaction primitive for the CLI. Before this module there was none: every place that
 * wanted to show "which token is this" hand-rolled a slice, and a hand-rolled slice is exactly how a
 * credential ends up on a terminal (or in `/tmp/mcp-infra-kit.log`) in full.
 *
 * The rule it encodes: a rendered token shows AT MOST its last 4 characters, and never enough to
 * reconstruct it. Everything user-facing that names a token — `env-token-set`, `env-token-list`,
 * `doctor` — renders it through here, so the policy has ONE definition and one place to tighten.
 */

/** How many trailing characters a redacted token may reveal. Never raise this. */
const VISIBLE_SUFFIX_LENGTH = 4

/**
 * Below this length a token reveals NOTHING: showing the last 4 of a 6-char string hands over most of
 * it. Real Doppler service tokens are ~40+ chars, so this only ever fires for garbage input — which
 * is precisely when we must not be helpful.
 */
const MIN_LENGTH_FOR_SUFFIX = 8

/** The fixed-width mask. Fixed on purpose: a mask whose length tracked the token would leak its length. */
const MASK = '****'

/**
 * Render a token for human eyes: the mask, plus at most the last 4 characters.
 *
 * Total function — an empty, short, or malformed value returns the bare mask rather than throwing.
 * A redaction helper that can throw is a redaction helper that gets wrapped in a try/catch whose
 * fallback prints the raw value.
 *
 * @example
 * redactToken('dp.st.dev.abcdefgh1234') // => '****1234'
 * redactToken('short')                  // => '****'      (too short to reveal anything)
 * redactToken('')                       // => '****'
 */
export const redactToken = (token: string): string => {
  if (typeof token !== 'string' || token.length < MIN_LENGTH_FOR_SUFFIX) return MASK

  return `${MASK}${token.slice(-VISIBLE_SUFFIX_LENGTH)}`
}
