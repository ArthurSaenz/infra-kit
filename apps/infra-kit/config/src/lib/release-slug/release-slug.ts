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
 * Slugify an arbitrary string into a single DNS label: lowercase, collapse every
 * non-alphanumeric run to `-`, and drop leading/trailing separators. Returns `''`
 * when the input carries no alphanumeric run (the caller must treat that as "no label").
 *
 * portless rejects any hostname outside `[a-z0-9.-]`, so every segment fed into a
 * `<release>.<packageName>.localhost` alias must pass through here. A scoped npm name
 * (`@hulyo/client-ui`) is the motivating case: registering it raw fails with
 * `Invalid hostname`, and because the driver swallows that into a best-effort `false`,
 * the whole hero-URL path degrades silently to `localhost:<port>`.
 *
 * Distinct from {@link slugifyRelease}: this does NOT strip a git-flow prefix, so a
 * package legitimately named `fix-utils` keeps its `fix-` prefix.
 *
 * @example
 * slugifyHostLabel('@hulyo/client-ui') // => 'hulyo-client-ui'
 * slugifyHostLabel('backend-api')      // => 'backend-api'
 */
export const slugifyHostLabel = (label: string): string => {
  // Collect the alphanumeric runs and join with `-`. Doing it this way (rather
  // than collapse-then-trim) is linear and sidesteps a super-linear trim regex,
  // while inherently dropping any leading/trailing separators.
  const runs = label.toLowerCase().match(/[a-z0-9]+/g)

  return runs ? runs.join('-') : ''
}

/**
 * Slugify a git branch into a `<release>` token: strip a leading git-flow prefix
 * (`feature/`, `release/`, …), then reduce the remainder to a single DNS label.
 *
 * @example
 * slugifyRelease('release/2.4')     // => '2-4'
 * slugifyRelease('feature/HUL-123') // => 'hul-123'
 */
export const slugifyRelease = (branch: string): string => {
  return slugifyHostLabel(branch.replace(/^(?:feature|feat|release|hotfix|bugfix|fix|chore)\//i, ''))
}

/**
 * The `<release>` label used when no git branch resolves (outside a repo, or a branch that slugifies to
 * nothing). Both the dev-server's alias writer and `infra-kit/vite`'s template interpolation fall back
 * to this SAME constant — a divergence here would emit a hostname no alias backs.
 */
export const DEFAULT_RELEASE_SLUG = 'local'
