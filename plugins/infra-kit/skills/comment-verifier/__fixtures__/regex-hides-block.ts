// A trimmed copy of the shape at `apps/infra-kit/cli/src/dev/ports.ts`, where a regex literal
// holding a quote hid the JSDoc block below it from an earlier comment reader. Kept as a fixture so
// the regression stays checkable in a repo that does not carry that source file.

export function parsePortString(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') {
    return undefined
  }

  const n = parseInt(raw.trim().replace(/^["']|["']$/g, ''), 10)

  return Number.isNaN(n) ? undefined : n
}

/**
 * Resolve the EXPLICITLY-configured port for an API app (highest priority first): `{APP}_PORT` — e.g.
 * `CLIENT_PORT` — then a bare `PORT`, then `dev.<app>.port` from infra-kit.json, or `undefined` when
 * none is set. Per-app env keys use the app folder name in **UPPER_SNAKE_CASE**.
 *
 * There is deliberately NO default-port tier: `undefined` is what distinguishes an app the developer
 * pinned to a port from an unconfigured app, which binds ephemeral straight away under dynamic
 * allocation.
 *
 * `allowBarePort` gates ONLY the second tier, and defaults to `true` so every standalone caller keeps
 * today's precedence. The per-app `{APP}_PORT` and `dev.<app>.port` tiers are unaffected either way.
 *
 * This block is fourteen lines long on purpose: it is the payload the reader must not lose.
 */
export const DEFAULT_PORT_TIERS = 3
