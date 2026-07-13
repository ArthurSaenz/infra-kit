/**
 * Thin, injectable driver for the `portless` daemon (Layer B — see `.omc/plans/dev-https-portless.md`).
 *
 * `infra-kit dev` uses it to register `<release>.<package>.localhost → 127.0.0.1:<port>` routes so the
 * hero URLs resolve over **HTTPS on :443, with no port in the URL**. Every call here is **time-bounded and
 * never throws**: a missing binary, a non-zero exit, or a wedged process resolves to `false`/no-op. That is
 * a reporting contract, not a tolerance one — portless IS a hard dependency of the dev loop, and
 * `DevServerRunner.ensureProxy` turns a `false` from this driver into a fatal, actionable start error.
 *
 * The binary is NOT resolved from `PATH`: `portless` is a normal npm dependency living in
 * `node_modules/.bin`, which is on `PATH` only when the process was launched via pnpm/npm. Since
 * `infra-kit dev` is often launched otherwise (a global bin, a cmux runner, a foreign cwd), we resolve
 * portless's own `dist/cli.js` by walking `node_modules` from this file (see {@link resolvePortlessBin})
 * and run it with the current `node` (`process.execPath`) — so it works regardless of how `dev` was
 * invoked. Args are fixed literals plus discovered release/package names + a numeric port, never
 * shell-interpolated.
 *
 * **The daemon is PROBED, never started.** `:443` is privileged, and portless binds it by re-execing
 * itself through `sudo` with an inherited stdio — which a detached `stdio:'ignore'` child can never
 * satisfy: the password prompt has nowhere to go. Setup is one-time and out-of-band: a root
 * `portless service install`, printed for the user by {@link formatPortlessCommand} (never as a bare
 * `portless`, which no shell can resolve — see there).
 *
 * All process I/O is injected (`run` for awaited commands, `isProxyServing` for the wire probe) so tests
 * never shell out and can assert the exact portless argv.
 */
import type { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { withoutPackageManagerEnv } from 'src/lib/pm-env'

const execFileAsync = promisify(execFile)

/** Read `bin.portless` (the `dist/cli.js` relative path) from a portless `package.json` on disk. */
const readBinRel = (pkgJsonPath: string): string | null => {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { bin?: string | Record<string, string> }
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.portless

  return rel == null || rel === '' ? null : rel
}

/**
 * Resolve the absolute path to portless's CLI entry (`portless/dist/cli.js`) from node_modules,
 * independent of `PATH`. Returns `null` when portless is not installed, degrading the whole driver to
 * a no-op.
 *
 * portless is ESM-only (its `.` export exposes only `import`/`types`, no `require`), so
 * `createRequire().resolve` can't see it. We instead walk `node_modules` upward from this file — the
 * standard resolution path — and read the package's `package.json` straight off disk, which bypasses the
 * exports map that would otherwise hide both `package.json` and the main entry.
 */
export const resolvePortlessBin = (): string | null => {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))

    for (;;) {
      const pkgJsonPath = join(dir, 'node_modules', 'portless', 'package.json')

      if (existsSync(pkgJsonPath)) {
        const rel = readBinRel(pkgJsonPath)

        return rel == null ? null : join(dirname(pkgJsonPath), rel)
      }
      const parent = dirname(dir)

      if (parent === dir) return null
      dir = parent
    }
  } catch {
    return null
  }
}

/** Resolve portless's CLI once per process — the on-disk location never changes within a run. */
let cachedBin: string | null | undefined
const portlessBin = (): string | null => {
  if (cachedBin === undefined) cachedBin = resolvePortlessBin()

  return cachedBin
}

/**
 * Characters that survive a POSIX shell unquoted. Anything outside this set (a space, a paren — both of
 * which appear in real install paths like `/Applications/My Editor.app`) gets single-quoted.
 */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/

/** A literal `'` inside single quotes: close, emit an escaped quote, reopen — the only way a shell allows it. */
const SINGLE_QUOTE_ESCAPE = "'\\''"

/** Single-quote `value` for a POSIX shell unless it is already inert. */
const shellQuote = (value: string): string => {
  return SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", SINGLE_QUOTE_ESCAPE)}'`
}

/** Seams for {@link formatPortlessCommand}, injected so tests never depend on the real node_modules layout. */
export interface FormatPortlessCommandOptions {
  /**
   * Absolute path to portless's `dist/cli.js`. **Required and non-nullable on purpose.** The caller must
   * have resolved portless before it can describe how to run it, so "I could not find the binary" cannot be
   * silently rendered as a plausible-looking command — the type makes that unwritable rather than merely
   * discouraged. A `null` bin is a different report ("run `pnpm install`"), which every caller makes first.
   */
  bin: string
  /** Prefix with `sudo` — only `service install`, which binds the privileged `:443`, needs it. */
  sudo?: boolean
  execPath?: string
}

/**
 * Render a portless command the user can actually paste into a shell.
 *
 * This exists because the obvious string is a lie. `portless` is a plain npm dependency living in
 * `node_modules/.bin`, which is on `PATH` only inside a pnpm/npm script — so printing `sudo portless service
 * install` hands the user a command that dies with `sudo: portless: command not found`. `sudo` makes it
 * strictly worse: it replaces `PATH` with `secure_path`, so even a shell that *could* resolve `portless`
 * loses it the moment the command is elevated.
 *
 * We therefore print what the driver itself runs (see {@link defaultRun}): the current interpreter, by
 * absolute path, invoking portless's `dist/cli.js`, by absolute path. Nothing is resolved from `PATH`, so the
 * command works under `sudo`, from any cwd, and however `infra-kit` was launched.
 *
 * This is not merely cosmetic. portless's `service install` writes **the interpreter and script path it was
 * invoked with** straight into the launchd plist's `ProgramArguments` (`nodePath: process.execPath` plus
 * `process.argv[1]`), so the command printed here is the command that gets installed as a **root system
 * daemon**. Printing a name for the shell to resolve would not just fail — it would decide what runs as root.
 *
 * @example
 * formatPortlessCommand(['service', 'install'], { sudo: true, bin })
 * // 'sudo /usr/local/bin/node /repo/node_modules/portless/dist/cli.js service install'
 */
export const formatPortlessCommand = (args: string[], options: FormatPortlessCommandOptions): string => {
  const words = [options.execPath ?? process.execPath, options.bin, ...args]
  const prefix = options.sudo === true ? 'sudo ' : ''

  return prefix + words.map(shellQuote).join(' ')
}

/** Awaited portless invocation. Rejects on non-zero exit / timeout; the driver swallows that into a no-op. */
export type PortlessRun = (args: string[], opts: { timeoutMs: number }) => Promise<void>

/** Cheap "is anything at all accepting TCP here?" pre-filter in front of the wire probe. */
export type IsListening = (port: number) => Promise<boolean>

/**
 * Ground-truth identity: is the process serving `port` actually **portless**, and (when `tls`) is it
 * serving **TLS**? See {@link defaultIsProxyServing} for why this cannot be answered from state files.
 */
export type IsProxyServing = (port: number, tls: boolean) => Promise<boolean>

const DEFAULT_TIMEOUT_MS = 1500
const PROBE_TIMEOUT_MS = 1500

/** Response header portless sets on every response it serves. Node lower-cases response header names. */
const PORTLESS_HEADER = 'x-portless'

/** IPv4 loopback: portless binds and dials `127.0.0.1`. */
const LOOPBACK = '127.0.0.1'

/**
 * SNI for the probe. Node sends **no SNI to an IP literal** (RFC 6066), which would drop portless onto its
 * default certificate — whose SANs are `localhost`, `*.localhost`, `*.local` and contain **no IP entry**.
 * `localhost` is always in that set, so it is the one name guaranteed to work even on a machine with zero
 * aliases registered.
 */
const PROBE_SERVERNAME = 'localhost'

export const defaultIsListening: IsListening = (port) => {
  return new Promise((resolve) => {
    const socket = net.connect({ host: LOOPBACK, port })
    const finish = (result: boolean): void => {
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => {
      finish(true)
    })
    socket.once('timeout', () => {
      finish(false)
    })
    socket.once('error', () => {
      finish(false)
    })
  })
}

/**
 * Is the listener on `port` portless itself, serving `tls`? Proven **on the wire**, by asking it: portless
 * sets `X-Portless: 1` on every response, before route lookup — so an unrouted host still answers the probe
 * (a 404 with the header is a pass). This mirrors portless's own `isProxyRunning`.
 *
 * This replaces the old state-file check (`proxy.port` + `proxy.pid`), which was **unsound**: portless's
 * `resolveStateDir(_port)` ignores its port argument, so `proxy.port` / `proxy.pid` / `proxy.tls` are
 * process-global singletons shared by every daemon on every port. Starting ANY daemon rewrites them, and
 * stopping ANY daemon DELETES them — so a second, unrelated daemon (or a stale sibling repo still on the
 * old CLI, falling back to an unprivileged port) makes a perfectly healthy `:443` daemon look dead. Both
 * were reproduced against portless 0.15.1; see `.omc/research/portless-https-spike.md`.
 *
 * `rejectUnauthorized: false` is deliberate and load-bearing: this probe answers *"is portless serving
 * here?"*, **never** *"is its CA trusted?"*. Validating the chain here would collapse two different
 * failures — a daemon that is down, and a CA that was never trusted — into one indistinguishable error,
 * with two different fixes (a root `service install` vs the sudo-free `trust`). Trust is a separate,
 * explicitly-validating probe (doctor's CA check).
 */
export const defaultIsProxyServing: IsProxyServing = (port, tls) => {
  return new Promise((resolve) => {
    const request = tls ? https.request : http.request
    const req = request(
      {
        host: LOOPBACK,
        port,
        method: 'HEAD',
        path: '/',
        timeout: PROBE_TIMEOUT_MS,
        ...(tls ? { rejectUnauthorized: false, servername: PROBE_SERVERNAME } : {}),
      },
      (res) => {
        res.resume()
        resolve(res.headers[PORTLESS_HEADER] === '1')
      },
    )

    req.on('error', () => {
      resolve(false)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

const defaultRun: PortlessRun = async (args, { timeoutMs }) => {
  const bin = portlessBin()

  if (bin == null) throw new Error('portless is not installed (not resolvable from node_modules)')
  await execFileAsync(process.execPath, [bin, ...args], {
    signal: AbortSignal.timeout(timeoutMs),
    encoding: 'utf-8',
    env: withoutPackageManagerEnv(process.env),
  })
}

/**
 * portless's state directory. Exported so `doctor` reports on the same directory the driver reads.
 *
 * The default is deliberately **unchanged** (`~/.portless`): portless's `service install` bakes
 * `PORTLESS_STATE_DIR`, resolved from `SUDO_USER`, into the launchd plist — so the root daemon reads the
 * *invoking user's* home. Pointing this anywhere else by default would manufacture the very split it looks
 * like it prevents.
 */
export const portlessStateDir = (): string => {
  return process.env.PORTLESS_STATE_DIR ?? join(homedir(), '.portless')
}

/** portless's local CA certificate — the root every host cert it mints is signed by. */
const CA_CERT_FILE = 'ca.pem'

/**
 * Marker portless's `trust` writes: the **hex sha256 of `ca.pem`'s bytes** that was added to the login
 * keychain (`writeTrustMarker` → `caFingerprint`, `cli.js:78-101`). It records WHICH CA was trusted, so a
 * regenerated CA leaves a marker that no longer matches.
 */
const CA_TRUST_MARKER_FILE = 'ca.trusted'

/** A route portless is serving: `<name> → 127.0.0.1:<port>`. */
export interface PortlessRoute {
  /**
   * The registered hostname (e.g. `2-4.client-api.localhost`). Usable verbatim as a
   * `portless alias --remove <name>` argument — portless strips a trailing TLD off the name it is handed
   * (`parseHostnames`, `chunk-SD2PIWJU.js:68-79`) — and as a TLS `servername`.
   */
  name: string
  port: number
}

/** Absolute path to portless's local CA certificate, in whichever state dir {@link portlessStateDir} names. */
export const readCaPath = (): string => {
  return join(portlessStateDir(), CA_CERT_FILE)
}

/**
 * Was `portless trust` run for the CA that is on disk right now? Compares `sha256(ca.pem)` against the
 * fingerprint recorded in `ca.trusted`. `false` when either file is missing; never throws.
 *
 * **This proves the marker was written for THIS fingerprint — not that the keychain still trusts it.** A
 * user who deletes the certificate from Keychain Access by hand leaves the marker behind and gets a false
 * pass here. That residual is accepted (reading the keychain would mean shelling out to `security` on a
 * check that must stay cheap); it is why this is a *separate* check from the chain handshake
 * ({@link handshakeChainsToCa}), which proves what the daemon actually serves.
 */
export const caFingerprintMatches = (): boolean => {
  try {
    const recorded = readFileSync(join(portlessStateDir(), CA_TRUST_MARKER_FILE), 'utf-8').trim()

    if (recorded === '') return false

    const actual = createHash('sha256').update(readFileSync(readCaPath())).digest('hex')

    return actual === recorded.toLowerCase()
  } catch {
    return false
  }
}

/** Outcome of {@link handshakeChainsToCa}: `code` is the Node TLS error code, which the caller discriminates on. */
export type HandshakeResult = { ok: true } | { ok: false; code: string }

/**
 * Does the certificate served on `port` chain to the CA in `ca.pem`? A **validating** TLS handshake — the
 * complement of {@link defaultIsProxyServing}, which deliberately does not validate.
 *
 * `servername` is **mandatory and load-bearing**, never optional: Node sends no SNI to an IP literal
 * (RFC 6066), which drops portless onto its default certificate, whose SANs (`localhost`, `*.localhost`,
 * `*.local`) contain **no IP entry** — so a validating probe of `127.0.0.1` with no `servername` fails with
 * `ERR_TLS_CERT_ALTNAME_INVALID` against a perfectly healthy daemon. Any such code coming back from here is
 * therefore a bug in the CALLER's probe, never a finding about the user's trust store. Passing an
 * unregistered name is safe: portless's SNI callback mints a cert on demand for any servername.
 *
 * Time-bounded; never throws.
 */
export const handshakeChainsToCa = (port: number, servername: string): Promise<HandshakeResult> => {
  return new Promise((resolve) => {
    let ca: Buffer<ArrayBufferLike>

    try {
      ca = readFileSync(readCaPath())
    } catch {
      resolve({ ok: false, code: 'ENOENT' })

      return
    }

    const socket = tls.connect({ host: LOOPBACK, port, servername, ca: [ca], rejectUnauthorized: true }, () => {
      // With `rejectUnauthorized: true` a chain failure normally surfaces as an 'error' event and this
      // callback never runs; the check is here so a future Node that connects-then-reports can't slip a
      // rejected chain through as a pass.
      const authError = socket.authorizationError as NodeJS.ErrnoException | undefined
      const authorized = socket.authorized

      socket.destroy()
      resolve(authorized ? { ok: true } : { ok: false, code: authError?.code ?? authError?.message ?? 'UNKNOWN' })
    })

    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('timeout', () => {
      socket.destroy()
      resolve({ ok: false, code: 'ETIMEDOUT' })
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      socket.destroy()
      resolve({ ok: false, code: err.code ?? 'UNKNOWN' })
    })
  })
}

/**
 * Routes portless currently has registered, read from `routes.json` in {@link portlessStateDir}. `[]` on any
 * failure (absent file, malformed JSON, unexpected shape) — an unreadable route list is reported as "no
 * routes", never as an error, because every caller uses this for diagnostics only.
 */
export const listRoutes = (): PortlessRoute[] => {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(portlessStateDir(), 'routes.json'), 'utf-8'))

    if (!Array.isArray(raw)) return []

    return raw.flatMap((entry): PortlessRoute[] => {
      const { hostname, port } = (entry ?? {}) as { hostname?: unknown; port?: unknown }

      if (typeof hostname !== 'string' || hostname === '' || typeof port !== 'number') return []

      return [{ name: hostname, port }]
    })
  } catch {
    return []
  }
}

export interface PortlessDriver {
  /**
   * Absolute path to the `dist/cli.js` this driver executes, or `null` when portless is not installed.
   *
   * Exposed so a caller rendering a remediation ({@link formatPortlessCommand}) names the binary THIS driver
   * would run, rather than re-resolving one behind its back — which, under an injected driver, would print a
   * fix derived from the real machine instead of the one under test.
   */
  binPath: () => string | null
  /** Resolve (and memoize) whether the `portless` binary is usable. Absent → every other call no-ops. */
  isAvailable: () => Promise<boolean>
  /**
   * Is a portless daemon serving `port` over `tls`? **Probe only — this never starts anything.** Binding
   * the privileged `:443` needs root, and portless's sudo re-exec cannot prompt from a detached child, so
   * the daemon is installed once, out-of-band (a root `service install`). A `false` here is turned into a
   * fatal, actionable start error by the caller.
   */
  isProxyServing: (port: number, tls: boolean) => Promise<boolean>
  /**
   * Register `<name> → 127.0.0.1:<port>` (`name` = `<release>.<package>`). Returns `true` on success so
   * the caller shows the hero URL only for an alias that actually resolves (best-effort otherwise).
   */
  registerAlias: (name: string, port: number) => Promise<boolean>
  /** Deregister `<name>`. Best-effort. */
  removeAlias: (name: string) => Promise<void>
}

export interface PortlessDriverDeps {
  /** Override the resolved `dist/cli.js` path (default: the real node_modules walk). Injected in tests. */
  bin?: string | null
  run?: PortlessRun
  /** TCP liveness pre-filter (default: real `net` connect). Injected in tests. */
  isListening?: IsListening
  /** Wire-probe identity check (default: real `HEAD /` + `X-Portless`). Injected in tests. */
  isProxyServing?: IsProxyServing
  timeoutMs?: number
}

/**
 * Build a {@link PortlessDriver}. Inject `run` in tests to assert argv without shelling out.
 * `isAvailable` memoizes so the binary is probed at most once per runner.
 */
export const createPortlessDriver = (deps: PortlessDriverDeps = {}): PortlessDriver => {
  const bin = deps.bin === undefined ? portlessBin() : deps.bin
  const run = deps.run ?? defaultRun
  const isListening = deps.isListening ?? defaultIsListening
  const isProxyServing = deps.isProxyServing ?? defaultIsProxyServing
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let availability: boolean | null = null

  /** Run a portless subcommand, swallowing any failure into `false` (best-effort contract). */
  const tryRun = async (args: string[]): Promise<boolean> => {
    try {
      await run(args, { timeoutMs })

      return true
    } catch {
      return false
    }
  }

  const isAvailable = async (): Promise<boolean> => {
    availability ??= await tryRun(['--version'])

    return availability
  }

  const serving = async (port: number, tls: boolean): Promise<boolean> => {
    if (!(await isAvailable())) return false
    // Nothing is even accepting TCP → skip the (more expensive) wire probe entirely.
    if (!(await isListening(port))) return false

    return isProxyServing(port, tls)
  }

  const registerAlias = async (name: string, port: number): Promise<boolean> => {
    if (!(await isAvailable())) return false

    return tryRun(['alias', name, String(port)])
  }

  const removeAlias = async (name: string): Promise<void> => {
    if (!(await isAvailable())) return
    await tryRun(['alias', '--remove', name])
  }

  return {
    binPath: () => {
      return bin
    },
    isAvailable,
    isProxyServing: serving,
    registerAlias,
    removeAlias,
  }
}
