# [DO] Local Dev Infrastructure Plan — Backend, Port Management & Git Worktrees

> Status: **design / proposal** · Owner: infra-kit · Last updated: 2026-07-06
>
> This document captures the requirements and a proposed architecture for the next
> phase of local-development tooling in `infra-kit`, focused on **running the backend
> across multiple git worktrees simultaneously** without port collisions, with stable
> URLs that also work from **Postman**. Frontend is considered solved (Vite defaults +
> proxy + port management) and is only revisited where it consumes the backend.

---

## 1. Context — what exists today

`infra-kit` is the **tooling monorepo itself**; the dev-server is a *generic runner* that,
when invoked inside a consumer monorepo, discovers that repo's `apps/<app>/api` (fastify
emulating AWS Lambda + API Gateway) and `apps/<app>/ui` (opaque — runs each UI's own `dev`
script). Key facts that constrain the design:

| Concern | Where it lives | Behaviour today |
|---|---|---|
| Port resolution | `apps/infra-kit/cli/src/dev/ports.ts` → `resolvePort` | `{APP}_PORT` env → `PORT` env → `dev.<app>.port` (infra-kit.json) → **`DEFAULT_PORT = 3010`**. Static, one canonical port per app, machine-wide. |
| Bind | `apps/infra-kit/cli/src/dev/serverless-local-run.ts:111` | `server.listen({ port, host: '127.0.0.1' })` — host hardcoded. |
| Conflict guard | `dev-server.ts:assertNoPortConflicts` / `ports.ts:findPortConflicts` | Throws on collision **within one runner's app set only** — no machine-wide awareness. |
| Process model | `dev-server.ts:startAllApps` | **One `infra-kit dev` process runs N fastify apps**, each on its own port (`Promise.all`). Optionally N UI dev servers via one delegated `turbo run dev`. |
| Worktrees | `commands/worktrees-{add,list,sync,reload}` | `git worktree add` + `pnpm install` + open IDE/cmux windows. **Zero runtime differentiation** — no per-worktree port, URL, or env. |
| Env | `commands/env-load` (Doppler) | Project-root scoped (a worktree is its own root → own cache), **but the port vars themselves come from the same Doppler config → identical values across worktrees**. |
| Runtime config | `infra-kit.json` | `dev.<app>.port`, `dev.<app>.prefixUrl` (`/api/v1` default). (`infra-kit.config.ts` is audit-only.) |
| Frontend proxy | consumer repos | No Vite proxy in infra-kit; UIs are opaque. Consumer `vite.config.ts` proxies to the backend URL. |

**The single assumption to break:** every worktree that sources the same Doppler config
resolves the **same** ports → simultaneous worktrees collide (`EADDRINUSE` / trip
`assertNoPortConflicts`). The entire assumption is centralized in `ports.ts` (`resolvePort`,
`DEFAULT_PORT`) with the bind at `serverless-local-run.ts:111`.

---

## 2. Requirements

1. **R1 — N worktrees in parallel.** Local dev must run the backend for several git
   worktrees at the same time (e.g. `main`, `feature/HUL-123`, `release/2.4`). No single
   fixed port binding.
2. **R2 — Port management.** Collision-free, deterministic where possible, ideally with the
   developer never typing a port number.
3. **R3 — Reference package.** [`vercel-labs/portless`](https://github.com/vercel-labs/portless)
   may be used directly or its OSS code vendored/adapted. **Decision pending — user wants to
   see the concrete multi-instance URL scheme first (§6).**
4. **R4 — Postman across worktrees.** When the backend runs inside a specific worktree, it
   must be reachable from Postman via a stable address. **Both** a movable "current" alias and
   permanent per-worktree URLs are wanted (§7).
5. **R5 — Plain HTTP.** Local transport is plain HTTP (no local CA to install/trust) — chosen
   to keep Postman/CI friction low.
6. **R6 — Frontend unchanged (single-worktree).** Vite defaults keep working; the only backend
   touchpoint is the proxy target the UI consumes — already the env var `VITE_PROXY_URL_LOCAL_CLIENT`.
   Caveat surfaced in §8: for *parallel* worktrees the UI also needs a per-worktree port and
   per-worktree proxy URL, so "solved" holds only for one worktree today.

---

## 3. The portless model, and how it maps to us

**What portless does:** a reverse-proxy daemon that assigns each dev process an ephemeral
port (via `PORT`, range 4000–4999) and routes stable `.localhost` hostnames → those ports.
Notable for us:

- **Native git-worktree support** — auto-prefixes the branch name as a subdomain:
  `fix-ui.myapp.localhost`. This *is* R4's per-worktree URL, for free.
- **/etc/hosts auto-sync** so non-browser clients (Postman, `curl`) resolve `*.localhost`.
  (Critical: macOS only special-cases bare `localhost` in browsers; arbitrary `*.localhost`
  needs a hosts entry or resolver — this is what makes Postman work at all.)
- Node 24+ (infra-kit already runs Node 24.x), macOS/Linux/Windows.

**The architectural mismatch to be aware of.** portless assumes **one process = one port =
one hostname**. infra-kit runs **one `infra-kit dev` process = N fastify apps = N ports**.
So we cannot simply wrap `infra-kit dev` as a single portless-managed process — a single
injected `PORT` can't feed N apps. The clean reconciliation is to treat portless as the
**proxy + route-registry layer** and have infra-kit **register each app's port** with it,
rather than let portless launch/own the dev process.

This is why the integration is best framed as **two independent layers**:

```
Layer B — Addressing (proxy + route registry + /etc/hosts)   ← portless (or vendored)
                    ▲  hostname → port routes
                    │
Layer A — Port allocation (per app, per worktree)            ← infra-kit dev-server
```

Either layer can be adopted alone. Layer A alone gives collision-free ports (but ugly
`:PORT` URLs). Layer B alone gives clean URLs (but needs Layer A to hand it ports). We want
both.

---

## 4. Proposed architecture

### Layer A — per-worktree port allocation (owned by infra-kit)

Change `resolvePort` (`dev/ports.ts`) to add a **per-worktree dimension**. Two sub-options,
not mutually exclusive:

- **A1 — deterministic offset (recommended default).** Derive a stable offset from the
  worktree identity (hash of the canonical worktree path or branch → a slot 0..N), and
  compute `port = appBasePort + slot * STRIDE`. Deterministic ⇒ the same worktree always gets
  the same ports across restarts (stable for debugging, stable even without the proxy), and
  collision-free across worktrees by construction. Record the assigned slot in the worktree's
  `infra-kit.json` (or a sibling `.infra-kit/worktree.json`) at `worktrees-add` time so it's
  explicit and reproducible.
- **A2 — dynamic free port (`listen(0)`).** Bind port 0, let the OS pick. Zero collision risk,
  but non-deterministic between restarts — only acceptable **behind** the proxy (Layer B),
  because clients address by hostname, never by port. Infra already proves this works: free
  ports are used in dev test fixtures today.

Recommendation: **A1 by default** (deterministic, debuggable, works with or without the proxy);
allow A2 when Layer B is active and determinism isn't needed.

The bind stays `127.0.0.1`. `assertNoPortConflicts` remains a within-process sanity check;
cross-worktree safety comes from the offset/dynamic allocation, not from a machine-wide scan.

### Layer B — stable addressing (portless, or a vendored mini-proxy)

A single machine-wide reverse proxy on **port 80** (plain HTTP per R5) maps hostnames to the
Layer-A ports and keeps `/etc/hosts` in sync. infra-kit's dev-server, when it starts each
fastify app, **registers a route** `<hostname> → 127.0.0.1:<port>` and deregisters on shutdown
(it already tracks app lifecycle and has a `/__health` route for readiness).

**Hostname scheme (canonical)** — the thing R2/R4 hinge on:

```
http://<release-name>.<package-name>.localhost     permanent, per worktree   (R4 per-worktree URL)
http://<package-name>.localhost                    movable alias → "focused" worktree   (R4 alias)
```

- `<release-name>` = the worktree's release-branch slug. Worktrees are created per release branch
  by `worktrees-add` (under `…-worktrees/{release,feature}/<branch>`), so the release name is the
  natural, stable worktree identifier — assigned & collision-checked at `worktrees-add` time.
- `<package-name>` = the monorepo package being served (the `apps/<app>/api` folder / package name).
  One release runs **many** packages; each gets its own hostname **sharing the same
  `<release-name>` prefix**. So a single worktree exposes e.g.
  `http://2-4.client-api.localhost`, `http://2-4.media.localhost`, `http://2-4.dynamic.localhost`.
- The alias `http://<package-name>.localhost` (no release segment) is a route infra-kit repoints to
  whichever worktree is currently focused.

Because every package in a worktree shares the `<release-name>` segment, infra-kit only has to make
the release slug known once (env / `--focus`); each package's URL is composed from it.

> **Port-80 note:** serving clean `http://name.localhost` (no `:port`) requires the proxy to
> own port 80, which needs one-time privilege (root / `launchd`/`systemd` service / `setcap`).
> portless already manages this as a daemon. If we vendor, we install a user-level service
> once. The fallback (no privilege) is `http://name.localhost:PORT_PROXY` — clean-ish but the
> port leaks back into URLs, undermining R2. Recommend paying the one-time daemon cost.

---

## 5. Integration decision (R3) — phased

Given the N-apps-per-process mismatch (§3) and that infra-kit **already vendors** shared code
as a first-class pattern, the recommendation is staged rather than all-or-nothing:

- **Phase 0 — spike (1–2 days).** Wrap `portless` as-is around a single app in two worktrees
  to validate the URL/worktree UX and the /etc/hosts + port-80 story end-to-end, including a
  Postman hit. Deliverable: the developer sees the §6 URLs actually resolve. This answers the
  user's "show me it works for multiple instances" before we commit.
- **Phase 1 — Layer A in infra-kit.** Land per-worktree deterministic ports (A1) in
  `dev/ports.ts` + record the slot at `worktrees-add`. This alone unblocks R1/R2 (collision-free
  parallel worktrees) with `:PORT` URLs — useful even before the proxy exists.
- **Phase 2 — Layer B.** Either keep the portless daemon and have infra-kit register routes
  with it, **or** vendor portless's proxy + route-registry into infra-kit (single integrated
  tool, tuned to our worktree/env/turbo conventions, matching the existing vendor pattern). The
  spike informs which. Vendoring is favored long-term for one-tool cohesion and control over
  the plain-HTTP/port-80 behaviour; wrapping is favored if upstream portless proves low-friction.

The public API the developer sees (`infra-kit dev`, the URLs) is identical either way, so the
wrap-vs-vendor choice can be deferred to after the spike without reworking consumers.

---

## 6. Worked example — URLs for multiple worktree instances

Consumer repo has a backend package `client-api`. Developer has three checkouts (release-based
worktrees). Canonical URL = `http://<release-name>.<package-name>.localhost`:

| Checkout | Path | Release name | Layer-A port (A1, base 3010, stride 10) | Per-worktree URL (Layer B) |
|---|---|---|---|---|
| main | `~/proj/acme` | `main` | `3010` | `http://main.client-api.localhost` |
| worktree | `~/proj/acme-worktrees/feature/HUL-123` | `hul-123` | `3020` | `http://hul-123.client-api.localhost` |
| worktree | `~/proj/acme-worktrees/release/2.4` | `2-4` | `3030` | `http://2-4.client-api.localhost` |

Each worktree runs **many** packages, all sharing its `<release-name>` prefix — so the `2-4`
worktree simultaneously exposes `http://2-4.client-api.localhost`, `http://2-4.media.localhost`,
`http://2-4.dynamic.localhost`, etc., and its UI's three Vite proxy paths target those three
distinct package URLs (§8).

Plus the movable alias, e.g. focused on HUL-123:

```
http://client-api.localhost   →  (currently)  http://hul-123.client-api.localhost  →  127.0.0.1:3020
```

Switching focus: `infra-kit dev --focus hul-123` (or a `worktrees-focus` command) just
repoints the alias route; the per-worktree URLs never change.

Running all three at once — three terminals / cmux panes, each in its worktree:

```bash
# ~/proj/acme                     (main)
doppler run -- infra-kit dev      # binds :3010, registers main.client-api.localhost + alias

# ~/proj/acme-worktrees/feature/HUL-123
doppler run -- infra-kit dev      # binds :3020, registers hul-123.client-api.localhost

# ~/proj/acme-worktrees/release/2.4
doppler run -- infra-kit dev      # binds :3030, registers 2-4.client-api.localhost
```

No port typed anywhere; no collision; every instance individually addressable.

---

## 7. Postman strategy (R4) — both alias + per-worktree

Because Layer B gives **stable hostnames** (never ports), Postman collections never break on
restart. Concretely:

- **Per-worktree environment.** One Postman *environment* per active worktree, each setting
  `{{baseUrl}}` to that worktree's permanent URL:
  - `HUL-123` → `baseUrl = http://hul-123.client-api.localhost`
  - `release-2.4` → `baseUrl = http://2-4.client-api.localhost`
- **"Current" environment.** One environment `current` → `baseUrl = http://client-api.localhost`
  (the alias). Selecting it always hits whichever worktree you've focused — the common case.
- Requests use `{{baseUrl}}/api/v1/...` (matches the dev-server's default prefix). Switching
  worktrees in Postman = the environment dropdown. Plain HTTP (R5) ⇒ **no CA/cert step**.

**Automation (recommended, low cost):** have `worktrees-add`/`worktrees-sync` maintain a
generated Postman environment file, e.g. `postman/worktrees.postman_environment.json` listing
every live worktree URL. Creating a worktree adds its environment; syncing (PR closed) removes
it. The developer just imports/refreshes in Postman. This keeps Postman in lockstep with the
worktree set with zero manual bookkeeping and directly satisfies R4.

---

## 8. Frontend / Vite implications (R6) — grounded in the Hulyo client app

The UI stays opaque to infra-kit, but the real config (`hulyo-monorepo/apps/client/ui/vite.config.ts`)
shows the seam is **already env-var driven**, which makes this clean:

```ts
// apps/client/ui/vite.config.ts (actual, trimmed)
if (command === 'serve') {                                 // fail fast in dev
  const missing = ['VITE_PROXY_URL_LOCAL_CLIENT'].filter((k) => !env[k])
  if (missing.length) throw new Error(`Missing dev env vars: ${missing} — source from Doppler
    (source $(infra-kit env-load dev | jq -r .filePath)); this repo has NO .env files`)
}
const proxyUrl = env.VITE_PROXY_URL_LOCAL_CLIENT || ''
return {
  server: {
    port: env.VITE_SPA_MODE === 'true' ? 3005 : 3000,      // ← hardcoded UI port
    proxy: { '/api': proxyUrl, '/dynamic': proxyUrl, '/media': proxyUrl },  // ← target is env-driven
  },
}
```

Two facts that shape the design:

1. **The backend proxy target is a single indirection point.** Today it's the Doppler env var
   `VITE_PROXY_URL_LOCAL_CLIENT` (the repo has no `.env` files). That's enough to prove the seam is
   *one* place — but a single value can't express per-worktree × per-source (local/cloud) routing. §8a
   replaces this one env read with a small declarative config + an infra-kit Vite helper (still a
   one-line consumer config, just no env vars).
2. **The UI has the *same* worktree-collision as the backend, one level up.** `server.port` is
   **hardcoded to 3000/3005** — two worktree UIs collide on 3000 just like two backends collide on
   3010. And today `VITE_PROXY_URL_LOCAL_CLIENT` resolves to the *same* Doppler value in every
   worktree, so every worktree's UI would proxy to the *same* backend. So "frontend is solved" holds
   only for a single worktree — parallel worktrees need the UI port and the proxy URL to be
   per-worktree too.

**Implications / required changes:**

- **UI port must become per-worktree** (`server.port` is hardcoded 3000/3005): either an
  infra-kit-computed per-worktree offset, or register the UI with Layer B so an ephemeral port is fine
  and it's addressed as `<release>.client.localhost`.
- **The proxy target must become per-worktree and per-source (local vs cloud).** Rather than injecting
  a pile of env vars, this is done **declaratively in config** — see §8a. That is the design the rest
  of this section adopts.

**Bottom line for R6:** the frontend needs *no structural rewrite* — only (1) a per-worktree UI port,
and (2) the proxy targets resolved from a small declarative config instead of a static Doppler URL.

### 8a. Config-first proxy routing (declarative, template-interpolated)

Preference (chosen): **no env-var pile in the consumer config.** Instead, addresses live in one
declarative place — `infra-kit.json` (the runtime config) — as **URL templates with placeholders**,
and each route declares which **source** it comes from. infra-kit interpolates the placeholders and
hands the UI a ready-made proxy map.

```jsonc
// infra-kit.json  → dev.proxy   (runtime config; infra-kit.config.ts stays audit-only)
{
  "dev": {
    "proxy": {
      "templates": {                                    // {rel} {pkg} {env} are substituted by infra-kit
        "local": "http://{rel}.{pkg}.localhost",
        "cloud": "https://{env}.hulyo.co.il"            // path-routed; or "https://{pkg}.{env}.hulyo.co.il"
      },
      "routes": {
        "/api":     { "pkg": "client-api", "from": "local" },
        "/media":   { "pkg": "media",      "from": "cloud" },
        "/dynamic": { "pkg": "dynamic",    "from": "cloud" }
      }
    }
  }
}
```

**Placeholders** (resolved by infra-kit, never by the developer): `{rel}` = this worktree's release
slug (derived from its git branch), `{pkg}` = the route's package, `{env}` = the cloud env name — taken
from the **Doppler env you already loaded** (`infra-kit env-load <env>`), **not** a committed `cloudEnv`
field. That's the whole point of dropping `cloudEnv`: the template keeps `{env}` as a slot, but its
value comes from the env context you're already in, so there's no second source of truth to drift. If
you ever need to switch cloud env *locally*, that's a rare runtime `--cloud <env>` override
(§dev-context). **`from`** ∈ `local | cloud | auto`. `auto` = local when infra-kit is actually running
that package this run, else cloud — the "derive it from `--app`/`--ui`" convenience, opt-in per route.

**Consumer `vite.config.ts` becomes one env-free line** — infra-kit ships the helper that reads the
config, interpolates, applies the cloud gotchas, and also returns the per-worktree UI port:

```ts
import { infraKitDev } from 'infra-kit/vite'
export default defineConfig(async () => ({
  server: await infraKitDev(),   // → { port, proxy }  (no env vars, no hardcoded URLs)
}))
```

`infraKitDev()` interpolates each route's template and, for `cloud` targets, auto-applies the options
that make local-FE → cloud-BE actually work:

```ts
// what the helper produces for a "cloud" route (illustrative)
'/media': { target: 'https://dev.hulyo.co.il', changeOrigin: true, secure: false, cookieDomainRewrite: 'localhost' }
// and for a "local" route
'/api':   { target: 'http://2-4.client-api.localhost', changeOrigin: true }
```

**Why config-first beats the env-var approach here:**
- Addresses live in **one versioned, reviewable place**; not scattered across Doppler + shell env.
- Flipping a route local↔cloud is a **one-word edit** (`"from": "cloud"`) — or `--cloud`/`--app` at
  runtime for `from: "auto"` routes. No per-path env plumbing.
- The consumer config reads **no env vars** and hardcodes **no URLs**.
- The `cloud` template **encodes the cloud topology as config** (path-routed vs per-service subdomain),
  which answers Q6 declaratively instead of in code.

**Runtime inputs, without env vars in user code:** `{rel}` the helper derives from git; `{env}` from the
loaded Doppler env name (or a rare `--cloud <env>` override); the `auto` local-set from what
`infra-kit dev` started. The two runtime choices (`--cloud` override, started-package set) reach the
helper via a small **gitignored dev-context file** (`.infra-kit/dev-context.json`), not env vars. Absent
the file, the helper falls back to config + git-derived `{rel}` + the loaded env.

**Cost to be honest about:** this introduces an infra-kit-provided Vite helper (`infra-kit/vite`) — a
real API surface infra-kit must ship and keep Vite-compatible. That is the price of the ergonomics, and
it matches how infra-kit already ships shared tooling. A pure-string escape hatch remains: any route may
set an absolute `url` instead of `pkg`/`from` (`{ "url": "https://my-tunnel.trycloudflare.com" }`) for
teammate tunnels / one-offs.

Ergonomics recap (with `from: "auto"` routes, the flags you already type are the selector):

| Command | `auto` routes resolve to |
|---|---|
| `infra-kit dev --ui` | all local |
| `infra-kit dev --ui --app client-api` | client-api local; media, dynamic cloud |
| `infra-kit dev --ui --app none` (frontend-only) | all cloud |

**Load-bearing convention (still enforced):** for `local` the `{rel}.{pkg}.localhost` host holds only
while `subdomain == package-name`; a package whose host differs falls back to an absolute `url` route.
`{rel}` must be a stable, collision-checked, DNS-safe slug owned by `worktrees-add` (Q3).

---

## 9. Change surface in infra-kit (for planning)

| # | File | Change |
|---|---|---|
| 1 | `apps/infra-kit/cli/src/dev/ports.ts` (`resolvePort`) | Add per-worktree offset (A1) / dynamic (A2) dimension. |
| 2 | `apps/infra-kit/cli/src/dev/serverless-local-run.ts:111` | Keep `127.0.0.1`; expose the resolved port for route registration. |
| 3 | `apps/infra-kit/cli/src/dev/dev-server.ts` | On app start/stop, register/deregister `<host>→127.0.0.1:<port>` with the proxy; wire `--focus`. |
| 4 | new: proxy client / vendored proxy | Talk to portless daemon **or** vendor the reverse-proxy + route-registry + /etc/hosts sync. |
| 5 | `commands/worktrees-add` | Assign & record the worktree slot/short-name; emit/refresh the Postman environment file. |
| 6 | `commands/worktrees-sync` | Remove the worktree's Postman environment entry + proxy routes on teardown. |
| 7 | `infra-kit.json` schema | Add `dev.proxy` (`templates.local/cloud` with `{rel}`/`{pkg}`/`{env}`, `routes.<path>.{pkg,from\|url}`); optional `dev.worktree.stride`/slots. No `cloudEnv` field — `{env}` comes from the loaded Doppler env. |
| 8 | new: `infra-kit/vite` helper (`infraKitDev()`) | Read `dev.proxy`, interpolate `{rel}`/`{pkg}`/`{env}`, apply cloud proxy opts (changeOrigin/secure/cookieDomainRewrite), return `{ port, proxy }`. The consumer `vite.config.ts` collapses to one call. |
| 9 | consumer UI `vite.config.ts` | Replace hardcoded `server.port`/`proxy` + env reads with `server: await infraKitDev()`. |
| 10 | dev-server → `.infra-kit/dev-context.json` | Write the runtime context (started-package set for `from:auto`, chosen `--cloud` env, resolved `{rel}`) as a gitignored file the helper reads — no env vars. |
| 11 | `infra-kit dev` CLI | Allow starting the UI with **zero/subset** of backends (`--app none` / `--no-api`) and pick the cloud env (`--cloud <env>`); `from:auto` routes follow it. |

---

## 10. Open questions & risks

- **Q1 — Wrap vs vendor portless (R3):** deferred to after the Phase 0 spike. Signal to decide:
  does portless's daemon expose a clean route-registration API infra-kit can drive for N apps,
  or must we vendor to get that? Deep-dive user leaning: "use it if we can."
- **Q2 — Port 80 privilege:** acceptable to run a user-level daemon owning :80 (clean URLs), or
  must we stay unprivileged (URLs carry `:PORT`)? Affects R2 cleanliness.
- **Q3 — Worktree → subdomain slug collisions:** two branches slugging to the same subdomain
  (`feature/x` vs `feature-x`). Need a deterministic, collision-checked slug (owned by
  `worktrees-add`, recorded).
- **Q4 — Non-browser resolution of `*.localhost`:** confirmed we rely on /etc/hosts sync (or a
  resolver) for Postman/`curl`; this must be owned by whichever proxy we run, and is a
  privileged write — same daemon concern as Q2.
- **Q5 — Doppler port vars:** if a consumer's Doppler config hardcodes `{APP}_PORT`, the
  per-worktree offset must override it (precedence today puts `{APP}_PORT` first). Decide whether
  the worktree offset wins over `{APP}_PORT` or only over the config/default.
- **Q6 — Cloud topology for the mixed local/cloud fallback (§8a):** is the cloud env **path-routed on
  one host** (`https://dev.hulyo.co.il` → `/api`, `/media`) or **per-service subdomains**
  (`https://media.dev.hulyo.co.il`)? This picks the single `cloudUrl(base, pkg)` convention. Also
  decide the default cloud env (`dev`?) and whether local auth/session works against it (cookie/CORS —
  see the §8a gotchas).

---

## 11. Recommendation summary

1. **Adopt the two-layer model.** infra-kit owns Layer A (per-worktree ports); a proxy owns
   Layer B (stable `*.localhost` addressing).
2. **Spike portless first** (Phase 0) on two worktrees to validate the §6 URLs + Postman +
   plain-HTTP/port-80 story, then decide wrap vs vendor (§5).
3. **Land deterministic per-worktree ports** (A1) in `dev/ports.ts` regardless — it's the
   collision fix and is independently useful.
4. **Hostname scheme:** `http://<release-name>.<package-name>.localhost` (permanent, per worktree) +
   `http://<package-name>.localhost` (movable alias), plain HTTP. All packages in a worktree share
   the `<release-name>` prefix, so the release slug is injected once and each package URL is composed
   from it — including the three distinct Vite proxy targets (`/api`, `/dynamic`, `/media`).
5. **Postman:** generate/refresh per-worktree + `current` environments from
   `worktrees-add`/`sync`; requests use `{{baseUrl}}/api/v1/...`.
6. **Frontend:** Vite proxies at a stable hostname (alias or per-worktree env var); infra-kit
   surfaces the resolved backend URL into the env so consumer configs stay worktree-agnostic.
