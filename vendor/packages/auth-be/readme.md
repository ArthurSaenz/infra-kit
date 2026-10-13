# @wl/auth-be

Passwordless (magic-link) authentication for a Lambda API: request a link → verify it → a
15-minute access JWT + a 7-day rotating refresh JWT in `HttpOnly` cookies, refresh-token reuse
detection, logout, `me`. It owns the flow and none of the storage: the host passes its user table,
token / session / rate-limit stores and mailer in as small interfaces (`src/ports.ts`). Frontend
counterpart: `@wl/auth-fe`.

A host can run several instances side by side (e.g. one over a customers table, one over a staff
table); each host's wiring is one `createAuth(...)` call. A sibling API can call `verifySession` to
honour the same cookie.

## Portability contract

- Runtime dependency: `jsonwebtoken`. No imports from `apps/*` or `packages/*`, no AWS SDK, no ORM.
  Copy `vendor/packages/auth-be` into another repo, `pnpm add jsonwebtoken`, build.
- Errors are `AuthError { code, status }` unless the host passes `createError` to map them onto its
  own error class (e.g. a `ManagedError`, so the browser sees the same `type`).
- Every store method gets the caller's context as its last argument, untouched (`TCtx`), so
  repositories that take an options bag (`{ logger }`) plug in directly.

## Public API

| Export                                                                                     | What it is                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createMagicLinkAuth(config)`                                                              | The engine: `requestMagicLink`, `sendInviteLink`, `verifyMagicLink`, `refreshSession`, `logout`, `requireUser`, `authenticate`, `getMe`, `issueSession`, cookie helpers. |
| `createAuthRoutes(auth, { corsHeaders, requestMagicLinkMessage? })`                        | The five endpoints as Lambda bodies (`requestMagicLink`, `verifyMagicLink`, `refresh`, `logout`, `me`), each `{ handle, fallbackResponse?, clearCookiesOn401? }`.        |
| `toLambdaHandler(route, options)`                                                          | A complete handler for hosts without their own controller envelope (maps `AuthError`, honours fallback / clear-cookies).                                                 |
| `verifySession(headers, { issuer, audience, accessSecret })`                               | For another service behind the same origin: the access-token payload or `null`. Fails closed.                                                                            |
| `signAccessToken` / `verifyAccessToken` / `signRefreshToken` / `verifyRefreshToken`        | HS256 with issuer + audience pinning.                                                                                                                                    |
| `sanitizeRedirectUrl`, `extractAccessToken`, `extractRefreshToken`, `buildClearCookies`, … | The pure helpers the engine is built from.                                                                                                                               |

### `createMagicLinkAuth` config

| Key                                                                     | Required | Meaning                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                                                                 | yes      | `{ findByEmail, findById }` → a row with `id`, `email`, `invited?`, `roles?`. The engine never creates users.                                                 |
| `magicTokens`                                                           | yes      | `{ create, consumeByHash, invalidateByEmail }`. `consumeByHash` must be single-use (return and spend atomically). Only SHA-256 hashes are stored.             |
| `sessions`                                                              | yes      | `{ create, findByTokenHash, rotate, revokeByTokenHash, revokeAllForUser }`. `rotate` must return `null` to the loser of a concurrent rotation.                |
| `rateLimiter`                                                           | yes      | `{ incrementAndCheck(key, limit, windowSec) }` → `{ allowed }`.                                                                                               |
| `mailer`                                                                | yes      | `{ send({ to, subject, text, html }) }`. A throw invalidates the undelivered token.                                                                           |
| `jwt`                                                                   | yes      | `{ accessSecret, refreshSecret, issuer, audience, accessTtlSec?, refreshTtlSec? }`. Secrets ≥ 32 chars and different from each other, or construction throws. |
| `magicLink`                                                             | yes      | `{ baseUrl, verifyPath = '/auth/verify', ttlMin = 15, inviteTtlMin = 4320 }`.                                                                                 |
| `email`                                                                 | yes      | `{ subject, intro, linkLabel, expiryPrefix?, warning? }`.                                                                                                     |
| `toMe`                                                                  | yes      | Row → the `GET me` DTO.                                                                                                                                       |
| `uninvitedRequest`                                                      | no       | `'silent'` (default: public surface, no membership oracle) or `'reject'` (NOT_INVITED 403, for internal tools).                                               |
| `isAllowed`, `rolesOf`, `onSignIn`                                      | no       | Allowlist predicate (default `invited === true`), roles claim (default `roles ?? []`), sign-in side effects.                                                  |
| `cookies`, `rateLimits`, `validate`, `createError`, `notInvitedMessage` | no       | Cookie names/paths (default `access_token` `/`, `refresh_token` `/api/v1/auth`), budgets (5/email, 20/IP per hour…), validators, error mapping.               |

### Invariants the engine keeps

- No user row is ever created by auth; the allowlist is re-asked at request, verify **and** refresh,
  and a refresh by a no-longer-allowed user revokes all their sessions.
- A replayed (already rotated) refresh token revokes every session of its user.
- Losing a concurrent rotation fails only that request.
- The redirect target is sanitised on write and on read: only an in-app path survives.

### Host wiring

```ts
const auth = createMagicLinkAuth<Customer, Me, Options>({
  users: { findByEmail: repo.getByEmail, findById: repo.getById },
  magicTokens,
  sessions,
  rateLimiter,
  mailer: { send: (m) => mail.send([m.to], m.subject, m.text, m.html) },
  jwt: { accessSecret, refreshSecret, issuer: 'my-api', audience: 'my-app' },
  magicLink: { baseUrl: 'https://app.example.com' },
  email: { subject: 'Sign in', intro: 'Use the link below to sign in:', linkLabel: 'Sign in' },
  toMe: (u) => ({ id: u.id, email: u.email }),
})
const routes = createAuthRoutes(auth, { corsHeaders })

// one Lambda per route
export const handler = toLambdaHandler(routes.verifyMagicLink, { corsHeaders, clearCookies: auth.clearCookies })
```
