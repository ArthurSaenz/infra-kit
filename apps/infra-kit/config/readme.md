# @slip-stream-kit/config

The config-authoring surface for [`infra-kit`](https://www.npmjs.com/package/infra-kit). Depends on
`zod` and nothing else.

## Why this package exists

It is not a convenience split — it is the only way `infra-kit` can be a global CLI.

Three facts force it:

1. **Node ESM cannot resolve a bare specifier from a global install.** `NODE_PATH` is ignored by ESM.
   So `import { defineConfig } from 'infra-kit'` in an `infra-kit.config.ts`, and
   `import { infraKitDev } from 'infra-kit/vite'` in a `vite.config.ts`, each force `infra-kit` to be a
   *local* dependency. Both `tsc --noEmit` and `vite` (a separate process) demand it.
2. **npm cannot install a package's `exports` without its `bin`.**
3. **A local `node_modules/.bin/infra-kit` shadows the global one.**

Together: while configs imported from `infra-kit`, a local install was mandatory, and that local
install hijacked every `pnpm exec infra-kit` call — so `npm i -g infra-kit` was inert, and every
consumer repo carried the CLI's full dependency tree (fastify, ink, react, chokidar, zx, …) just to
call an identity function.

**The bin-bearing package and the locally-resolved package must therefore be two different npm
packages.** This is the locally-resolved one. Install it as a devDependency; install `infra-kit`
globally.

## Usage

```ts
// infra-kit.config.ts
import { defineConfig } from '@slip-stream-kit/config'

export default defineConfig(() => ({ requiredScripts: [], requiredFiles: [] }))
```

```ts
// vite.config.ts
import { infraKitDev } from '@slip-stream-kit/config/vite'
import { defineConfig } from 'vite'

export default defineConfig(async ({ command }) => ({
  // Per-worktree dynamic dev port + the config-driven `dev.proxy`. Passing `command` makes it a
  // no-op for `build`.
  server: await infraKitDev({ command }),
}))
```

`@slip-stream-kit/vite` wraps that helper as a vite plugin (`plugins: [infraKit()]`) and adds what the
helper cannot do: it re-resolves the proxy while the server is up, so a backend started *after* the
frontend flips its route from `cloud` to `local` on its own. The helper here stays supported — use it
when you want the raw `server` block.

`dev.env` in `infra-kit.config.ts` adjusts the env the dev server sees, applied when vite serves (never on
`build` or under vitest). Requires `@slip-stream-kit/config` 0.15.0 or later — an older one rejects the key.
Use it for a loaded variable meant for another build mode that breaks local dev:

```ts
// apps/client/ui/infra-kit.config.ts — VITE_ORIGIN_DOMAIN is for vite.mobile.config.ts; on web it sends
// requests cross-origin around the dev proxy
export default defineConfig(() => ({ dev: { env: { unset: ['VITE_ORIGIN_DOMAIN'] } } }))
```

An edit to `dev.env` restarts the running dev server, except one: a name taken out of `unset` was already
deleted from the process env, so it comes back only after an `infra-kit dev` restart. `unset` removes the
inherited variable only; a value in the package's `.env` files still reaches `import.meta.env`.

```ts
// apps/<app>/tests/playwright.config.ts — the package's infra-kit.config.ts declares `e2e: { target: '<app>/ui' }`,
// and the target's own infra-kit.config.ts declares `deployedUrlEnv` (e.g. `CLIENT_URL`)
import { infraKitE2e } from '@slip-stream-kit/config/playwright'
import { defineConfig } from '@playwright/test'

const e2e = await infraKitE2e({ dir: import.meta.dirname })

export default defineConfig({
  webServer: e2e.webServer,
  use: { baseURL: e2e.baseURL, ignoreHTTPSErrors: e2e.ignoreHTTPSErrors },
})
```

Every run is local by default: `baseURL` is this worktree's alias for `e2e.target`, and `webServer` runs
`infra-kit dev <app> --reuse`, which reuses the dev server this worktree already runs or starts one for the
run (Playwright stops it after). `INFRA_KIT_E2E=cloud` — set by `infra-kit e2e --cloud`, and the default on
CI — points at the URL the loaded environment holds under the target's `deployedUrlEnv` instead, and
starts nothing. The helper never writes that variable: the dev server it starts proxies the UI's cloud routes
there.

```ts
// vendor.config.ts
import { defineVendorConfig } from '@slip-stream-kit/config'

export default defineVendorConfig({ copy: [] })
```

## Entry points

| Entry | Contents |
| --- | --- |
| `.` | `defineConfig`, `defineVendorConfig`, and the config types |
| `./vite` | `infraKitDev`, `infraKitProxy`, `loadPackageConfig`, `resolveProxyConfig`, `slugifyRelease` |
| `./playwright` | `infraKitE2e`, `DEV_SERVING_MARKER`, `E2E_MODE_ENV` |
| `./internal` | Consumed by the `infra-kit` CLI. **Not public API** — no stability guarantee |

## Versioning

Released in **lockstep** with `infra-kit`: the two share the same version line, always.

This is load-bearing, not cosmetic. The CLI self-updates silently on developer machines while this
package stays pinned in each consumer's lockfile, so a new CLI routinely meets an older helper. The
CLI guards that skew by comparing this package's version against a floor — a guard that only works
while both sides are points on the *same* version line. An independent version line here would make
the floor either reject every consumer or pass vacuously, and a vacuous pass silently reinstates the
failure the floor exists to prevent.
