/**
 * Shared, dependency-light release-slug helper.
 *
 * Extracted from `lib/vite/vite.ts` so BOTH the published `infra-kit/vite` helper
 * (which re-exports it) and the dev-server's dev-context fragment writer derive the
 * `<release>` hostname segment from ONE implementation — the recorded slug and the
 * helper-computed slug can never drift. Pure (regex only, no imports) so importing it
 * into the lightweight `infra-kit/vite` bundle stays cheap.
 */

/**
 * Slugify a git branch into a `<release>` token: strip a leading git-flow prefix
 * (`feature/`, `release/`, …), lowercase, collapse non-alphanumeric runs to `-`,
 * and trim stray dashes.
 *
 * @example
 * slugifyRelease('release/2.4')     // => '2-4'
 * slugifyRelease('feature/HUL-123') // => 'hul-123'
 */
export const slugifyRelease = (branch: string): string => {
  // Collect the alphanumeric runs and join with `-`. Doing it this way (rather
  // than collapse-then-trim) is linear and sidesteps a super-linear trim regex,
  // while inherently dropping any leading/trailing separators.
  const runs = branch
    .replace(/^(?:feature|feat|release|hotfix|bugfix|fix|chore)\//i, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)

  return runs ? runs.join('-') : ''
}
