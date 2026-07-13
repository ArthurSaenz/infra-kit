# [DO] Layer B — portless Phase-0 spike notes

> Status: **non-privileged half CONFIRMED (WRAP ratified so far)** · Owner: infra-kit · Date: 2026-07-07
>
> Companion to `.omc/plans/local-dev-worktrees-layer-a-b.md` (Phase 0 confirmation spike; Phase 3 WRAP,
> D2). Layer A (Phase 1) shipped in `ecd7dd2`. This note records what the live portless CLI actually
> does versus the plan's assumptions, so the Phase-3 daemon-driver code is written against verified
> behaviour rather than the plan author's reading of the docs.

## What was done

- **portless added as a real dependency** of the infra-kit CLI (`apps/infra-kit/cli/package.json`
  → `dependencies.portless: "^0.15.1"`). Deliberately a **real semver range, not `catalog:`** — the
  published `infra-kit` CLI must ship concrete ranges (`pnpm-workspace.yaml` `catalogMode: manual`
  comment; prior `react: catalog:` publish-leak). Installed version: **portless 0.15.1**. Node 26 here
  (portless requires Node 24+).
- Drove portless **by hand, unprivileged, plain HTTP** around one backend to confirm the WRAP
  primitives. No `sudo`, no `/etc/hosts` write, no `:80` — those are the deferred privileged half.

## plan-assumed command → real portless command

| Plan (`local-dev-worktrees-layer-a-b.md`) | Real portless 0.15.1 | Status |
|---|---|---|
| `portless proxy start --no-tls` | `portless proxy start --no-tls` (plain HTTP; default TLS on :443) | ✅ verbatim |
| unprivileged high-port proxy (D1 default) | `portless proxy start -p <port>` — help says **"custom port (no sudo)"**; composes with `--no-tls` | ✅ verbatim, **no thin-fallback needed** |
| `portless alias <release>.<pkg> <port>` | `portless alias <name> <port>` (+ `--remove`, `--force`) — "Register a static route" | ✅ verbatim |
| `portless hosts sync` / `portless hosts clean` | `portless hosts sync` / `portless hosts clean` (auto-sync on by default; `PORTLESS_SYNC_HOSTS=0` disables) | ✅ verbatim |
| `portless service install` (:80 launchd) | `portless service install [-p <port>] [--no-tls] [--https] [--lan]`, `service uninstall`, `service status` | ✅ verbatim |
| `portless list` (introspection) | `portless list` — "Show active routes" | ✅ present |
| `portless get <name>` (cross-service URL) | `portless get <name>` — "Print URL for a service" | ✅ present (bonus, useful for `--focus`/Postman gen) |

Reserved subcommands (cannot be app names): `run, get, alias, hosts, list, doctor, trust, clean, prune, proxy, service`.

## Phase-0 confirmation items (a–d)

- **(a) Dotted subdomain — ✅ CONFIRMED LIVE.** `portless alias 2-4.client-api 3999` →
  `Alias registered: 2-4.client-api.localhost -> 127.0.0.1:3999`, and `portless list` shows
  `http://2-4.client-api.localhost:8899 -> localhost:3999 (alias)`. The `<release>.<package>.localhost`
  §6 scheme is accepted as a dotted alias name; not just single-label hosts. (The alias `--help`
  examples only show single-label, so this needed the live test — now done.)
- **(b) `--no-tls` + `alias` + routing interop — ✅ CONFIRMED LIVE.** Proxy started
  `proxy start --no-tls -p 8899 --foreground` ("HTTP proxy listening on port 8899"). A backend on
  `127.0.0.1:3999` was reached **through the proxy by hostname**:
  `curl -H "Host: 2-4.client-api.localhost" http://127.0.0.1:8899/` → `BACKEND-OK on 3999`. This proves
  the proxy routes plain-HTTP by hostname (the `Host:` header bypasses `/etc/hosts`, so it isolates the
  routing layer from the resolver layer).
- **(c) `:80` daemon lifecycle + `service install` + high-port bind — PARTIAL.** High-port unprivileged
  bind (`-p 8899`) and `proxy start/stop` lifecycle confirmed live. The **`:80` bind and
  `service install` (launchd) are DEFERRED** — they need `sudo` and are the privileged half (see below).
- **(d) Cross-repo coexistence on one machine-global daemon — NOT TESTED.** Single daemon + single
  alias exercised; two repos into one `:80` daemon is deferred with the privileged half.

## WRAP-vs-vendor signal (D2)

**WRAP ratified so far — vendor fallback NOT triggered.** Every primitive Phase 3 depends on exists as
documented and behaved as documented in the live test: `alias` decoupled from process launch, `--no-tls`
plain HTTP, custom no-sudo port, dotted subdomain, hostname routing, `hosts sync`, `service install`.
The D2 fallback (vendor a ~200-line proxy) is only triggered if a confirmation item is refuted — none was.

## Deferred: the privileged half (needs `sudo` — user machine, manual)

The following were **not** run here because they mutate privileged system state and/or need a GUI client:

1. **`portless hosts sync`** — writes `/etc/hosts` so `curl`/**Postman** resolve
   `http://2-4.client-api.localhost:<port>` *without* a `Host:` header. Privileged write.
2. **`:80` bind** (`proxy start --no-tls` default port, or `service install`) — needs root / launchd.
   Default plan stance (D1) is the **unprivileged high-port** proxy, so `:80` is an opt-in upgrade, not a
   blocker.
3. **Cross-repo coexistence (item d)** and the **end-to-end Postman hit across ≥2 real worktrees** — the
   plan's manual/non-CI acceptance for Phase 3.

These do not change the WRAP decision; they gate the final Phase-3 e2e sign-off, which is inherently
manual (the plan labels it NON-CI).

## Recommendation → next gates before Phase-3 production code

WRAP is confirmed for the mechanism; before landing `src/dev/proxy/` daemon-driver code, two open plan
decisions still need the user's call (both flagged in the plan, neither resolvable from the docs):

- **R5 — UI-port discovery gate.** `startUiDev` spawns one `turbo run dev`; vite's UI port is never
  captured, so Layer B can't alias the UI. Decide (i) `strictPort:true` on a known UI port, or (ii) a
  UI-port-capture path. (Backend aliasing is unaffected — it already records the real bound port.)
- **Port-80 privilege default (D1).** Confirmed the unprivileged high-port path works end-to-end for
  routing; decide whether the shipped default is high-port (`:PORT` in URLs) or an opt-in `:80`
  `service install`. Affects only URL cleanliness, not the driver code shape.

Phase 2 (release-slug ownership + `worktrees.json` registry in `worktrees-add/sync`) is an unblocked,
zero-privilege, CI-testable prerequisite and is the natural next code milestone regardless of the above.
