# @slip-stream-kit/vite

The infra-kit Vite plugin. Wraps [`@slip-stream-kit/config`](https://www.npmjs.com/package/@slip-stream-kit/config)'s
`infraKitDev` helper, and adds the two things a plugin can do and a helper cannot.

```ts
// vite.config.ts
import { infraKit } from '@slip-stream-kit/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [infraKit()] })
```

That replaces:

```ts
export default defineConfig(async ({ command }) => ({ server: await infraKitDev({ command }) }))
```

The helper is not deprecated — it still ships from `@slip-stream-kit/config/vite`, and a repo that wants
the raw `server` block should keep using it. This package is for repos that want the plugin behaviour.

## What you get

**A dev server placed by `infra-kit dev`.** A per-worktree dynamic port (so N git worktrees never collide
on `5173`), or the exact port the runner assigned this UI — bound with `strictPort`, because the runner
already registered a portless alias against it. HMR is pointed at that alias (`wss://…`), so a page loaded
over HTTPS does not get its websocket blocked as mixed content.

**The `dev.proxy` map from your `infra-kit.config.ts`.** Each route resolves to the local backend when one
is running (the runner publishes the exact origin it registered) and to the cloud environment otherwise.

**A proxy that re-resolves while the server is up.** This is the part the helper cannot do. `infraKitDev()`
resolves once, while vite computes its config — so a backend started *after* the frontend can never flip
its route from `cloud` to `local`; the answer was already baked, and you restart vite by hand. The plugin
watches `.infra-kit/dev-context/` and restarts only when the resolved proxy actually changed. A backend
that dies demotes its route back to `cloud` the same way.

**No `command` to thread.** The plugin declares `apply: 'serve'`, and vite filters plugins by `apply`
*before* it runs their `config` hooks — so on `build` this plugin does not exist. Forgetting to pass
`{ command }` (which made a build fail-fast on a cloud route with no sourced env) is no longer possible,
because there is nothing to pass.

**Your own config still wins.** Vite merges a `config` hook's result *over* the user config, so a plugin
that returned everything it resolved would silently overrule a hand-pinned `server.port` or a hand-written
proxy route. This one emits only what you left unset — and warns when a pinned port contradicts the port
the runner aliased, because that combination 502s the hero URL and nothing else would tell you why.

## Options

Everything [`infraKitDev`](https://www.npmjs.com/package/@slip-stream-kit/config) accepts, except
`command` — plus:

| Option | Default | Meaning |
| --- | --- | --- |
| `restartOnDevContextChange` | `true` | Re-resolve the proxy and restart when the local dev set changes. `false` freezes the proxy at boot. |
| `cwd` | `process.cwd()` | The package dir whose `infra-kit.config.ts` is loaded. |
| `port` | dynamic | Pin the dev-server port. Overrides the runner's assignment (and will 502 the alias). |
| `host` | `127.0.0.1` | Vite's own `localhost` default binds `[::1]` only, which the proxy cannot dial. |
| `basicAuth` | from `E2E__BASIC_AUTH_*` | Credentials injected as an `Authorization` header on every route. |

## Versioning

Released in **lockstep** with `infra-kit` and `@slip-stream-kit/config` — one version line, always.

The CLI self-updates silently on developer machines while this package stays pinned in each consumer's
lockfile, so a new CLI routinely meets an older plugin. The CLI refuses to start against a plugin below
its floor rather than let an old one proxy plain HTTP at a TLS listener (a failure that is silent, because
portless answers `:80` with a 302 rather than refusing). That guard only works while both sides are points
on the same version line.
