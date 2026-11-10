import { DEV_CONTEXT_WIRE_VERSION } from '@slip-stream-kit/config/internal'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { readAppRelease } from 'src/lib/app-release'
import { INFRA_KIT_ENV_VAR } from 'src/lib/constants'

/**
 * One `.infra-kit/dev-context/<app>.json` fragment. `package` (feeds the vite helper's
 * `readLocalSet`) is the app's package name; `port` is the ACTUAL bound port (the writer
 * IS the binder). `release` lets the helper prefer the runner-recorded slug over its own
 * git derivation; `pid`/`writtenAt` are staleness metadata.
 *
 * `alias` is the registered portless hostname, and `origin` is **the authoritative local target** — the
 * exact origin the helper must proxy to, published by the runner rather than re-derived by the helper from
 * a template in a separately-versioned repo. The runner is the only party that knows what it actually
 * registered, so it says so; the helper obeys.
 *
 * `proxyPort` is deliberately NOT written any more.
 */
// Why `proxyPort` is omitted: the CLI self-updates while `infra-kit/vite` stays pinned per consumer, so a
// new CLI routinely meets an OLD helper — and that helper's `withProxyPort` grafts any port other than 80
// onto its target. Writing `proxyPort: 443` would therefore have produced `http://<alias>:443`: plain HTTP
// into a TLS listener, silently. Omitting the field leaves the old helper's target ungrafted instead.
// (That is not by itself a loud failure — `:80` is bound by portless's redirect server, so it 302s rather
// than refusing — which is why the CLI-side version floor, not this omission, is the load-bearing skew
// guard.)
interface DevContextFragment {
  /** Wire version. See {@link DEV_CONTEXT_WIRE_VERSION} — a promise that `origin` is present. */
  v: number
  package: string
  port: number
  pid: number
  writtenAt: number
  release: string
  alias: string
  origin: string
  /** `INFRA_KIT_ENV` this session runs with (`''` when none): its UIs proxy cloud routes to that env. */
  env: string
}

/** What a fragment needs to know about the app it describes. */
export interface DevContextApp {
  name: string
  packageName: string
  path: string
}

/**
 * This runner's own fragments in `<cwd>/.infra-kit/dev-context`: one `<app>.json` per app it serves
 * (or holds local). The `infra-kit/vite` helper searches up-tree for the directory and merges the
 * fragments of every runner, so each runner only ever writes and removes its own.
 */
export class DevContextStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /**
   * Atomically write this runner's `.infra-kit/dev-context/<app>.json` fragment recording the
   * ACTUAL bound port (REV-5: serialize to a same-dir temp file, then `renameSync` into place, so a
   * concurrent reader — the vite helper's directory merge — never observes torn JSON). Each runner
   * writes ONLY its own app's fragment, so Orca panes never clobber each other.
   */
  write(app: DevContextApp, boundPort: number, alias: string): void {
    const fragment: DevContextFragment = {
      // Declares the wire contract this fragment honours, so the helper never has to INFER it from a
      // package version — which stopped being inferable the moment the helper moved to its own npm
      // package with its own version line. `v` promises `origin` below is present and authoritative; the
      // helper refuses rather than guessing a target if that promise is ever broken.
      v: DEV_CONTEXT_WIRE_VERSION,
      package: app.packageName,
      port: boundPort,
      pid: process.pid,
      writtenAt: Date.now(),
      release: readAppRelease(app.path),
      alias,
      // The ORIGIN of the hero URL the ready screen prints (`resolveEndpointUrl` appends the app's
      // `prefixUrl` on top of this same alias). Prefix-free on purpose: this is a proxy target, and the
      // frontend supplies its own path.
      origin: `https://${alias}`,
      // The wizard assigns the picked env onto this process, so this is the session's env even when the
      // launching shell held another; `infra-kit e2e` compares it with its own before trusting the split.
      env: process.env[INFRA_KIT_ENV_VAR] ?? '',
    }

    const target = path.join(this.dir, `${app.name}.json`)
    const tmp = path.join(this.dir, `${app.name}.json.${process.pid}.tmp`)

    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(fragment, null, 2))
    fs.renameSync(tmp, target)
  }

  /** Remove THIS runner's own `<app>.json` fragment on shutdown (never another runner's). */
  remove(app: DevContextApp): void {
    fs.rmSync(path.join(this.dir, `${app.name}.json`), { force: true })
  }
}
