# lib-be-dev

Shared backend development utilities: a unified dev server runner, local Serverless-style runs via Fastify + `serverless.yml`, and a development logger aligned with AWS Lambda Powertools types.

Keep this package **identical** across monorepos that consume it (copy the whole `packages/lib-be-dev` folder when syncing).

## Contents

- **`dev-server.ts`** — Discovers each `apps/<app>/api` tree that has `serverless.yml`, builds with Turbo, runs each stack locally.
- **`serverlessLocalRun.ts`** — Fastify server that loads HTTP routes from `serverless.yml` and invokes compiled handlers.
- **`logger.ts`** — Chalk-based console logger implementing `ILogger` / Powertools-compatible surface.

## Dev server

From the monorepo root, run whatever script your root `package.json` exposes (commonly `tsx packages/lib-be-dev/src/dev-server.ts`).

| Flag                 | Purpose                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--watch` / `-w`     | Watch each `apps/<app>/api/src` and `packages/<pkg>/src`; rebuild with Turbo and restart affected processes. |
| `--app=name[,name2]` | Only apps whose folder name under `apps/` is listed.                                                         |
| `--exclude=name`     | Skip listed app folder names.                                                                                |

Runner messages append to **`packages/lib-be-dev/log.txt`**. Handler / Powertools output goes to **stdout** (the terminal).

### Ports

For app folder `my-app`, the runner reads, in order:

1. `process.env.MY_APP_PORT` (hyphens → underscores, uppercased)
2. `PORT` or `MY_APP_PORT` in `apps/my-app/api/.env`, then monorepo root `.env` (KEY=value lines; does not override already-set `process.env`)
3. `process.env.PORT`
4. Default **3010** (give each API a distinct port in real use)

You may wrap the command with a secrets tool (e.g. `doppler run -- …`) so ports and secrets exist in `process.env` before `.env` merge.

### Watch mode and tooling

- With `--watch`, Turbo builds use **`--force`** so `dist/` always matches disk.
- **`DEV_SERVER_CHOKIDAR_POLL=1`** — Enable polling if file watching fails (e.g. some Docker bind mounts).
- On start, **`POWERTOOLS_DEV`** and **`LOG_LEVEL`** default to `true` and `DEBUG` only if unset.

### Troubleshooting

- **`EADDRINUSE`** — Another process holds the port; stop the old dev server or free the port.
- **Redis / external services** — Ensure local URLs in `.env` match what your APIs expect (e.g. `REDIS_URL`).

## Usage as a library

```ts
import { Logger, ServerlessLocalRun } from '@pkg/lib-be-dev'
```

## `package.json` note

`@types/aws-lambda` and `@types/node` use **`catalog:`**. The workspace root `pnpm-workspace.yaml` must define matching `catalog` entries (same pattern in sibling monorepos).
