import { decidePrune, isDevSessionRunning } from 'src/commands/doctor/prune-routes'
import {
  caFingerprintMatches,
  createPortlessDriver,
  defaultIsListening,
  defaultIsProxyServing,
  formatPortlessCommand,
  handshakeChainsToCa,
  listRoutes,
  readCaPath,
  resolvePortlessBin,
} from 'src/dev/proxy/portless-driver'
import type { HandshakeResult, PortlessRoute } from 'src/dev/proxy/portless-driver'
import { serviceInstallCommand } from 'src/dev/proxy/portless-link'
import type { ServiceInstallSeams } from 'src/dev/proxy/portless-link'
import {
  PORTLESS_NODE_NAME,
  SERVICE_TARGET_NAME,
  checkPortlessServiceTarget,
  daemonStartedAt,
  resolveHealthySeams,
} from 'src/dev/proxy/portless-service-target'
import type { ServiceTargetDeps } from 'src/dev/proxy/portless-service-target'
import { DEFAULT_DEV_PROXY_PORT } from 'src/lib/infra-kit-config'
import { tildify } from 'src/lib/path-display'

import type { CheckResult } from '../check-result'

/** The sudo-free "trust the local CA" command, rendered from the same resolved bin. */
const trustCmd = (bin: string): string => {
  return formatPortlessCommand(['trust'], { bin })
}

/** TLS chain failures that mean "the daemon's cert does not chain to the `ca.pem` we hold". */
const CA_MISMATCH_CODES = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])

/**
 * A validating probe of an IP literal sends no SNI and lands on portless's default cert, which has no IP
 * SAN — so this code means OUR probe forgot a `servername`, never that the user's CA went bad. It must
 * never reach a `portless trust` remediation: doing so would tell every correctly-configured user to
 * repair a trust store that is fine.
 */
const PROBE_BUG_CODE = 'ERR_TLS_CERT_ALTNAME_INVALID'

/** Every process/fs seam the portless checks touch, injected so tests never reach the real daemon. */
export interface PortlessCheckDeps extends ServiceTargetDeps {
  resolveBin?: () => string | null
  isProxyServing?: (port: number, tls: boolean) => Promise<boolean>
  handshake?: (port: number, servername: string) => Promise<HandshakeResult>
  caTrusted?: () => boolean
  routes?: () => PortlessRoute[]
  isListening?: (port: number) => Promise<boolean>
  caPath?: () => string
}

// A function, not a module-scope const: suites that partially mock the config barrel leave the port
// undefined at import time, and a load-time read would fail those suites before any test runs.
const portlessServingName = (): string => {
  return `portless serving TLS on :${DEFAULT_DEV_PROXY_PORT}`
}

/** Is the daemon serving portless-over-TLS on the dev proxy port? Proven on the wire; reads no state file. */
const checkPortlessServing = async (
  isProxyServing: NonNullable<PortlessCheckDeps['isProxyServing']>,
  bin: string,
  seams: ServiceInstallSeams,
): Promise<CheckResult> => {
  const name = portlessServingName()
  const serving = await isProxyServing(DEFAULT_DEV_PROXY_PORT, true)

  if (!serving) {
    return {
      name,
      status: 'fail',
      message: `No portless daemon is serving HTTPS on :${DEFAULT_DEV_PROXY_PORT}. Install it once (needs root): \`${serviceInstallCommand(bin, seams)}\`.`,
    }
  }

  return { name, status: 'pass', message: `portless is serving HTTPS on :${DEFAULT_DEV_PROXY_PORT}` }
}

/**
 * Does the daemon serve a certificate that chains to the `ca.pem` on disk? The only check that VALIDATES
 * the chain — the serving probe above deliberately does not, so that a down daemon and an untrusted CA stay
 * two distinguishable failures with two different fixes.
 *
 * Probes `localhost` (always in the default cert's SANs, so it works on a fresh machine with zero aliases)
 * and, when one is registered, a real alias — which validates the exact path the browser takes.
 */
const checkPortlessCaChain = async (
  handshake: NonNullable<PortlessCheckDeps['handshake']>,
  routes: PortlessRoute[],
  caPath: string,
  bin: string,
  seams: ServiceInstallSeams,
): Promise<CheckResult> => {
  const name = 'portless CA chain valid'

  const servernames = [
    'localhost',
    ...routes.slice(0, 1).map((route) => {
      return route.name
    }),
  ]

  const results = await Promise.all(
    servernames.map(async (servername) => {
      return { servername, result: await handshake(DEFAULT_DEV_PROXY_PORT, servername) }
    }),
  )

  const failed = results.filter((entry) => {
    return !entry.result.ok
  })

  if (failed.length === 0) {
    return {
      name,
      status: 'pass',
      message: `Served certificate chains to ${tildify(caPath)} (${servernames.join(', ')})`,
    }
  }

  const codes = failed.map((entry) => {
    return entry.result.ok ? '' : entry.result.code
  })

  if (codes.includes(PROBE_BUG_CODE)) {
    return {
      name,
      status: 'fail',
      message: `Internal check error: the TLS probe got ${PROBE_BUG_CODE} for servername(s) ${failed
        .map((entry) => {
          return entry.servername
        })
        .join(', ')} — doctor's probe is wrong, your trust store is not implicated. Please report this.`,
    }
  }

  if (
    codes.some((code) => {
      return CA_MISMATCH_CODES.has(code)
    })
  ) {
    return {
      name,
      status: 'fail',
      message: `The daemon is serving a certificate that does not chain to ${tildify(caPath)}. Its CA was regenerated — run \`${trustCmd(bin)}\`, or reinstall: \`${serviceInstallCommand(bin, seams)}\`.`,
    }
  }

  return { name, status: 'fail', message: `TLS handshake failed (${codes.join(', ')})` }
}

/**
 * Was `portless trust` run for the CA now on disk? Fingerprint marker only — it proves the marker was
 * written for THIS `ca.pem` and the CA has not been regenerated since. It does NOT prove the keychain still
 * trusts it: a user who deletes the certificate by hand in Keychain Access leaves the marker behind and
 * passes here. Accepted residual (see `caFingerprintMatches`); the chain check above is what proves what the
 * daemon actually serves.
 */
const checkPortlessCaTrusted = (trusted: boolean, caPath: string, bin: string): CheckResult => {
  const name = 'portless CA trusted'

  if (!trusted) {
    return {
      name,
      status: 'fail',
      message: `The portless CA is not trusted (or was regenerated). Run: \`${trustCmd(bin)}\` (no sudo needed).`,
    }
  }

  return { name, status: 'pass', message: `${tildify(caPath)} matches the recorded ca.trusted fingerprint` }
}

/**
 * Routes whose target port has nothing listening — a worktree whose runner was SIGKILLed. Newly worth
 * surfacing under HTTPS: a dead target is now an opaque 502 from the proxy rather than a connection refusal.
 */
const checkPortlessStaleRoutes = async (
  routes: PortlessRoute[],
  isListening: NonNullable<PortlessCheckDeps['isListening']>,
  bin: string,
): Promise<CheckResult> => {
  const name = 'portless routes'

  if (routes.length === 0) return { name, status: 'pass', message: 'No portless routes registered' }

  const probed = await Promise.all(
    routes.map(async (route) => {
      return { route, live: await isListening(route.port) }
    }),
  )

  const stale = probed
    .filter((entry) => {
      return !entry.live
    })
    .map((entry) => {
      return entry.route.name
    })

  if (stale.length === 0) {
    return { name, status: 'pass', message: `${routes.length} portless route(s), all live` }
  }

  return {
    name,
    status: 'fail',
    message: `${stale.length} stale portless route(s): ${stale.join(', ')}. Remove with \`${formatPortlessCommand(['alias', '--remove', '<name>'], { bin })}\`.`,
  }
}

/**
 * The six rows after `portless installed`, in the order the evaluated path returns them. Every one needs
 * the binary, so an unresolvable one still emits them — as `skip` — and the section reads seven rows
 * either way.
 */
const portlessDependentNames = (): string[] => {
  return [
    PORTLESS_NODE_NAME,
    SERVICE_TARGET_NAME,
    portlessServingName(),
    'portless CA chain valid',
    'portless CA trusted',
    'portless routes',
  ]
}

/**
 * The portless block of doctor: is the HTTPS dev proxy installed, serving, trusted, and free of dead routes?
 * This is the diagnostic surface for the port-free HTTPS dev URLs — it is what tells a developer to run
 * `trust` (sudo-free) or the one-time `service install` (root), and it never conflates the two. Both are
 * printed via {@link formatPortlessCommand} — as `<node> <cli.js> …`, the only form that runs.
 *
 * Every check observes the daemon **on the wire or on our own disk** — never through portless's `proxy.port`
 * / `proxy.pid` / `proxy.tls` markers, which are process-global singletons that ANY daemon start rewrites and
 * ANY daemon stop deletes. Gating on them made doctor report a perfectly healthy `:443` daemon as dead.
 * (The one advisory that reads `proxy.pid` — {@link daemonStartedAt} — can only add a warning.)
 *
 * Reports only: nothing here is auto-run, and nothing requiring sudo ever could be.
 *
 * @example
 * await checkPortless()
 * // [{ name: 'portless installed', status: 'pass', message: '…' }, … 7 checks]
 */
export const checkPortless = async (deps: PortlessCheckDeps = {}): Promise<CheckResult[]> => {
  const resolveBin = deps.resolveBin ?? resolvePortlessBin
  const isProxyServing = deps.isProxyServing ?? defaultIsProxyServing
  const handshake = deps.handshake ?? handshakeChainsToCa
  const caTrusted = deps.caTrusted ?? caFingerprintMatches
  const readRoutes = deps.routes ?? listRoutes
  const isListening = deps.isListening ?? defaultIsListening
  const caPath = (deps.caPath ?? readCaPath)()
  // Resolved ONCE, then threaded into every remediation below: each one is rendered as `<node> <bin> …`, so a
  // check that could not name the binary could not print a runnable fix either.
  const bin = resolveBin()

  if (bin === null) {
    return [
      {
        name: 'portless installed',
        status: 'fail',
        message: 'portless is not resolvable from node_modules — run `pnpm install`.',
      },
      ...portlessDependentNames().map((name): CheckResult => {
        return { name, status: 'skip', message: 'portless not resolvable' }
      }),
    ]
  }

  const installed: CheckResult = {
    name: 'portless installed',
    status: 'pass',
    message: 'portless is resolvable from node_modules',
  }

  // The node row runs first: its verdict is what every remediation below renders `service install` through.
  const { seams, node } = resolveHealthySeams(deps, bin)
  const routes = readRoutes()
  const serving = await checkPortlessServing(isProxyServing, bin, seams)

  // Nothing is answering on :443 — there is no certificate to validate, so the chain check would only add a
  // second, derivative failure to the one the user must fix first.
  const chain: CheckResult =
    serving.status === 'fail'
      ? { name: 'portless CA chain valid', status: 'skip', message: 'no daemon to handshake with' }
      : await checkPortlessCaChain(handshake, routes, caPath, bin, seams)

  return [
    installed,
    node,
    (await checkPortlessServiceTarget(seams)).row,
    serving,
    chain,
    checkPortlessCaTrusted(caTrusted(), caPath, bin),
    await checkPortlessStaleRoutes(routes, isListening, bin),
  ]
}

/** Seams for {@link pruneStalePortlessRoutes}: the daemon, the wire and the process table, all injectable. */
export interface PruneRoutesDeps {
  routes?: () => PortlessRoute[]
  isListening?: (port: number) => Promise<boolean>
  /** Is a dev session alive? Defaults to a `ps` scan — see {@link isDevSessionRunning}. */
  devSessionRunning?: () => boolean
  removeAlias?: (name: string) => Promise<void>
}

/**
 * `doctor --fix`: remove the portless routes a dead dev-server left behind.
 *
 * The counterpart to {@link checkPortlessStaleRoutes}, which only ever REPORTS. Acting on the same
 * evidence needs one more guard, and it is not optional: "nothing is listening" cannot distinguish a dead
 * route from a UI whose vite has not bound its port yet (`assignUiPort` registers the alias, then
 * `getFreePort` RELEASES the port until vite boots — and a UI alias has no dev-context fragment to
 * corroborate it with). Every such false positive requires a dev session to be running, so a live dev
 * session withholds the prune entirely. See `prune-routes.ts` for the full argument.
 */
export const pruneStalePortlessRoutes = async (deps: PruneRoutesDeps = {}): Promise<CheckResult> => {
  const name = 'portless routes'
  const readRoutes = deps.routes ?? listRoutes
  const isListening = deps.isListening ?? defaultIsListening
  const devRunning = deps.devSessionRunning ?? isDevSessionRunning
  const routes = readRoutes()

  if (routes.length === 0) return { name, status: 'pass', message: 'No portless routes registered' }

  const probed = await Promise.all(
    routes.map(async (route) => {
      return { name: route.name, port: route.port, live: await isListening(route.port) }
    }),
  )

  const { prunable, withheld } = decidePrune(probed, devRunning())

  if (withheld.length > 0) {
    return {
      name,
      status: 'fail',
      message:
        `${withheld.length} route(s) look stale (${withheld.join(', ')}), but a dev session is running — ` +
        'a UI that has not bound its port yet is indistinguishable from a dead one, so nothing was removed. ' +
        'Stop dev and re-run `infra-kit doctor --fix`.',
    }
  }

  if (prunable.length === 0) {
    return { name, status: 'pass', message: `${routes.length} portless route(s), all live` }
  }

  const removeAlias = deps.removeAlias ?? createPortlessDriver().removeAlias

  // Serial, not `Promise.all`: each removal shells out to portless, which takes its own route lock.
  for (const alias of prunable) {
    await removeAlias(alias)
  }

  return {
    name,
    status: 'pass',
    message: `Removed ${prunable.length} stale portless route(s): ${prunable.join(', ')}`,
  }
}
