# @wl/auth-fe

Headless magic-link authentication for React: the API client, the session store, the single-flight
`fetchMe` with a silent refresh-then-retry on 401, verify, logout, `safeRedirect`, a provider with
hooks, and render-prop containers for the sign-in form, the verify page, the user menu and an auth
guard. It renders no markup of its own — every visible piece (form, spinner, menu, access-denied
screen) is the host's, passed in through `render` props, and navigation reaches the host only as
callbacks (`onAuthenticated(target)`, `onVerified(target)`, `onUnauthenticated()`, `onLoggedOut()`).
The package imports nothing from `apps/*` or `packages/*` and has no runtime dependencies — it is
meant to be copied into another project as-is (see "Portability contract").

A host typically wires it in one `src/features/auth/` folder: `services.ts` builds the app's store;
the containers wire the router, toasts and the app's UI components into the package containers.

## Public API

Root barrel (`src/index.ts`, re-exporting `src/features/auth/index.ts`):

- `createAuthClient<TUser>(options)` → `AuthClient<TUser>` (`services/auth-client.ts`). Plain `fetch`,
  JSON bodies, `credentials: 'same-origin'` by default. Options:
  - `paths: { requestMagicLink, verifyMagicLink, me, refresh, logout }` — required.
  - `baseUrl` (default `''`), `fetch` (default the global, looked up at call time so a stub installed
    later is still used), `credentials`.
  - `refresh` — replaces the client's own `POST paths.refresh`. A host that refreshes from more than
    one place passes its single-flight refresh here: two concurrent refreshes present the same refresh
    token twice, and a backend with reuse detection then revokes the session.

  Contract: `requestMagicLink` and `logout` reject on any non-2xx / network failure; `me` rejects with
  an `AuthHttpError` (`status`, `type` = the error body's `type`); `refresh` resolves a boolean and
  never rejects; `verifyMagicLink(token)` never rejects and resolves `{ ok, redirect?, errorCode? }` —
  GET `${paths.verifyMagicLink}?token=…`, `errorCode` is the body's `type` on a non-2xx (or on a 2xx
  without `ok: true`). A JSON body is read only when the response says `application/json`.

- `createAuthStore<TUser>(client, options?)` → `AuthStore<TUser>` (`services/auth-store.ts`). A
  framework-agnostic external store: `getState()`, `subscribe(listener)`, and the actions
  - `submitEmail({ email, redirectUrl? })` — trims and lower-cases the email, toggles
    `requestLoading`, clears `requestError` on start, sets `sentToEmail` on success or `requestError`
    (`options.requestErrorText`, default `DEFAULT_REQUEST_ERROR_TEXT`) on failure; resolves
    `{ ok, email }`.
  - `resetSentEmail()`.
  - `fetchMe()` — concurrent callers share one in-flight request; on a 401 it calls
    `client.refresh()` once and retries `/me` once; ends `authenticated` + `user`, or `unauthenticated`
    - `null`; `isSessionLoading` is true while it runs.
  - `verify(token)` — sets `authenticated` on success; returns the client's result.
  - `logout()` — always ends `unauthenticated` + `null`, even when the request fails.
  - `refresh()` — the client's refresh.

  `options.initialState` seeds any part of `AuthState` (tests, SSR hydration).

- `AuthState<TUser>`: `status` (`'unknown' | 'authenticated' | 'unauthenticated'`), `user`,
  `requestLoading`, `sentToEmail`, `requestError`, `isSessionLoading`.
- `AuthProvider` (`{ store, children }`), `useAuthStore<TUser>()` (the store, for its actions; throws
  outside a provider) and `useAuth(selector?)` (`useSyncExternalStore` over the store; the server
  snapshot is the same read). Return a primitive or a stored reference from `selector`.
- Containers (`containers/`), all render-prop and headless:
  - `AuthFormContainer({ redirect?, onAuthenticated, render })` — resolves an `unknown` session with
    `fetchMe`; once `authenticated`, calls `onAuthenticated(safeRedirect(redirect))`. `render` gets
    `{ status, loading, sentToEmail, error, onSubmit({ email }), onUseDifferentEmail }`; `onSubmit`
    sends `redirectUrl: safeRedirect(redirect)` and resolves `{ ok, email }` (toast it in the host).
  - `AuthVerifyContainer({ token?, redirect?, onVerified, render })` — no token → `error`; otherwise
    `loading` → `verify` → `fetchMe` → `onVerified(safeRedirect(response.redirect ?? redirect))`, or
    `error` when either step fails. `render(state)` with `'idle' | 'loading' | 'error'`.
  - `UserMenuContainer({ onLoggedOut, render })` — `null` unless authenticated with a user; `render`
    gets `{ user, onLogout }`, and `onLogout` logs out then awaits `onLoggedOut()`.
  - `RequireAuthContainer({ onUnauthenticated, onLoggedOut, fallback, isAllowed?, renderDenied?, children })`
    — resolves an `unknown` session; calls `onUnauthenticated()` once it is `unauthenticated`; renders
    `children` for a user `isAllowed` accepts, `renderDenied({ user, onLogout })` for one it rejects
    (the children never mount), and `fallback` otherwise.

  Host callbacks are read through a ref, so an inline arrow does not re-run a container's effect (and
  re-navigate) on every render.

- `safeRedirect(value?)` — the value when it is an in-app path (`/…`, not `//…`, no backslash or
  control character), else `'/'`. Browsers read `/\evil.com` as `//evil.com`.
- `AuthHttpError`, `isUnauthorized(error)` (duck-typed on `status === 401`, so a custom `AuthClient`
  only has to throw something carrying `status`), `DEFAULT_REQUEST_ERROR_TEXT`.
- Types: `AuthClient`, `AuthClientOptions`, `AuthPaths`, `AuthStore`, `AuthStoreOptions`, `AuthState`,
  `AuthStatus`, `AuthProviderProps`, `AuthFormContainerProps`, `AuthFormRenderProps`,
  `AuthVerifyContainerProps`, `AuthVerifyState`, `UserMenuContainerProps`,
  `RequireAuthContainerProps`, `SessionRenderProps`, `MagicLinkRequest`, `MagicLinkResult`,
  `VerifyMagicLinkResult`.

Usage:

```tsx
const authStore = createAuthStore(createAuthClient<User>({ paths: AUTH_PATHS }))

// root
;<AuthProvider store={authStore}>{children}</AuthProvider>

// sign-in page
;<AuthFormContainer
  redirect={redirect}
  onAuthenticated={(to) => navigate({ to, replace: true })}
  render={(form) => (form.status === 'unauthenticated' ? <SignInForm {...form} /> : <Spinner />)}
/>
```

## Portability contract

- No runtime `dependencies`; `react` (>= 19: the provider renders `<Context value>`) is the only peer.
  Zero imports from `apps/*` or `packages/*`; the devDependencies (`@wl/eslint-config`,
  `@wl/vitest-config`, vitest) are this repo's tooling and not needed by a copy.
- Nothing app-specific lives here: API paths, the user type, the refresh strategy, the error text, the
  admin rule and every component come from the host.
- No styles and no class names — a host needs no stylesheet import and no Tailwind `@source`.
- The API it expects: cookie sessions (no tokens in JS), `POST requestMagicLink { email, redirectUrl? }`,
  `GET verifyMagicLink?token=` → `{ ok: true, redirect? }` (sets the cookies), `GET me` → the user
  object unwrapped, `POST refresh`, `POST logout`; error bodies `{ type, message }`.
- Relative imports carry `.js`, so `tsc -b` output runs under Node ESM as well
  as a bundler.

To verify a copy (not automated):

1. New Vite + React 19 app; copy `vendor/packages/auth-fe/src` and `tsconfig*.json`.
2. `tsc --noEmit` clean.
3. Build a store against your API, mount `AuthProvider`, render `AuthFormContainer` and
   `AuthVerifyContainer` with your own form and navigation; sign in end to end.

## Layout

- `src/features/auth/services/` — `auth-client.ts`, `auth-store.ts`, `auth-context.ts` (context +
  hooks), `safe-redirect.ts`, `use-latest.ts`.
- `src/features/auth/containers/` — `auth-provider.tsx` and the four headless containers.
- `src/features/auth/__tests__/` — client, store, `safeRedirect` and container tests (browser mode).

## Commands

```bash
pnpm --filter @wl/auth-fe run build        # tsc -b → dist (apps consume dist: rebuild after edits)
pnpm --filter @wl/auth-fe run ts-check
pnpm --filter @wl/auth-fe run eslint-check
pnpm --filter @wl/auth-fe run test
```
