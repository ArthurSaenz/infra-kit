/**
 * Marker and version-line constants for the two managed guidance blocks.
 *
 * The repo root block lives in the repo's `CLAUDE.md`; every workspace package
 * gets its own block in its own `CLAUDE.md`. The two pairs are deliberately
 * distinct strings, and neither marker contains the other, so the `indexOf`
 * matching in `src/lib/managed-block` can never confuse them: a root block
 * pasted into a package directory is detectable as its own failure state
 * instead of silently counting as a package block.
 */

/** Start marker of the repo-root guidance block (HTML comment — invisible in rendered markdown). */
export const ROOT_MARKER_START = '<!-- infra-kit:begin -->'
/** End marker of the repo-root guidance block. */
export const ROOT_MARKER_END = '<!-- infra-kit:end -->'
/**
 * Prefix of the root block's version line. The version rides on its own line
 * (OMC's `OMC:VERSION:` precedent) so the markers themselves stay constant-matchable.
 */
export const ROOT_VERSION_PREFIX = '<!-- infra-kit:version '

/** Start marker of a per-package guidance block. */
export const PACKAGE_MARKER_START = '<!-- infra-kit:package:begin -->'
/** End marker of a per-package guidance block. */
export const PACKAGE_MARKER_END = '<!-- infra-kit:package:end -->'
/**
 * Prefix of a package block's version line. The line carries the CLI version
 * first and the resolved package type second — `<!-- infra-kit:package:version 0.4.0 frontend -->` —
 * so `extractVersion` (which reads to the first whitespace or `>`) returns the
 * version unchanged and a separate one-line parse reads the type.
 */
export const PACKAGE_VERSION_PREFIX = '<!-- infra-kit:package:version '
