# Dev-server wiring contract (consumers)

How a consumer monorepo wires `infra-kit dev`, what each wiring level guarantees, and the
release protocol for config-schema changes. Current as of infra-kit 0.3.10.

## The three UI wiring levels

| Wiring | Proxy resolution | Reacts to backend up/down | Health-probed | Status |
| --- | --- | --- | --- | --- |
| `infraKit()` vite **plugin** (`@slip-stream-kit/vite`) | live — watches the dev-context dir and restarts vite when routing changes | ✅ yes | ✅ yes (vite ping) | **required for managed UIs** |
| bare `infraKitDev()` **helper** (`@slip-stream-kit/config`) | baked once at vite config load | ❌ stale until manual restart | partial | discouraged — see below |
| **raw** vite config (hand-rolled proxy) | none (your own env vars) | ❌ | ❌ | outside `infra-kit dev` management; keep out of presets |

Every managed UI in hulyo and travelist uses the plugin. The dev runner's discovery treats
plugin- and helper-wired UIs identically (documented accepted residual in `dev-server.ts` —
the "row clears while helper still routes stale" hazard only exists for helper wiring, which
no consumer uses today). If you add a new managed UI, wire the **plugin**.

## Route + preset contract

In each UI's `infra-kit.config.ts`:

```ts
dev: {
  proxy: {
    templates: {
      local: 'https://<release>.<packageName>.localhost',  // MUST be https:// (portless serves TLS on :443)
      cloud: 'https://<env>.example.com',
    },
    routes: {
      '/api': { packageName: 'backoffice-api', from: ['local', 'cloud'], default: 'cloud' },
    },
  },
}
```

- `packageName` MUST equal the backend app's **actual `package.json` name** — dev-context
  fragments (which drive local routing) are keyed by real package names. A mismatch means the
  route can never resolve `local` and silently uses its `default`. (This exact drift shipped
  in travelist: routes said `back-office`/`api-handler`, packages are
  `sls-trvl-back-office`/`sls-trvl-api-handler`.)
- `devServersPresets` keys in `infra-kit.json` are `<app>/ui` or `<app>/api` — a bare `<app>`
  key fails validation loudly.
- A preset that pins a route `"local"` must also launch the backend that route names
  (hulyo pattern: `clientLocal` = `client/ui` (with the pin) + `client/api`).
- All of the above is validated by `infra-kit audit --root` (exit 1 on failure). Both
  consumers run it in `qa` via the root `infra-kit-check-root` script — keep that wired in CI.

## portless (the HTTPS proxy)

- URLs are port-free `https://<release>.<packageName>.localhost`; the portless daemon serves
  **TLS on :443** (the historical `:80 --no-tls` mode is obsolete — docs that mention it are
  spike/plan archives).
- One-time setup needs root: run the `sudo <node> <…/portless/dist/cli.js> service install`
  command that `infra-kit dev` prints (portless is never on PATH — always use the printed
  command). Trust the CA via `NODE_EXTRA_CA_CERTS="$HOME/.portless/ca.pem"` (see
  `local-dev-https-setup.md`).
- portless is mandatory: there is no `http://localhost:<port>` fallback; `infra-kit dev`
  refuses to run without the proxy.

## Config-schema release protocol (strict schema)

`infra-kit.config.ts` is parsed with a **strict** schema: unknown keys hard-fail every
command in the consumer repo. That couples schema changes to releases:

- **Adding a key**: ship the schema extension in a published `@slip-stream-kit/config` (and
  CLI, if it reads the key) release FIRST; consumers adopt the key only after upgrading.
  Adopting before upgrading bricks every command in that repo.
- **Removing a key**: two-phase — first release a version that accepts-and-ignores
  (deprecates) the key, let consumers migrate, then remove it in a later release. Never
  hard-remove in one step.
- Behavioral rules that can't be schema-enforced yet (e.g. `templates.local` must be
  `https://`) follow the same pattern: warn in one release, enforce in the next.
