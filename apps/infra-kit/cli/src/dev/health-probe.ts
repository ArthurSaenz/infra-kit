/**
 * @fileoverview
 * Loopback liveness probes for the apps `infra-kit dev` runs: a backend's `/__health`, a UI's vite ping.
 * Shared by the dev panel's health dots and by `infra-kit e2e`, which must agree on what "up" means.
 */

/** What a probe is aimed at. `kind` picks the endpoint AND the verdict rules — the two are not separable. */
export interface ProbeTarget {
  /** Stream tag (`<app>/api`, `<app>/ui`) — the key the health map and every log line agree on. */
  tag: string
  /** The port to probe: a backend's ACTUAL bound port, or a UI's runner-assigned vite port. */
  port: number
  kind: 'api' | 'ui'
}

/**
 * Something answered, but not the thing we asked for — and WHAT it answered is the whole diagnostic.
 *
 * A UI's `foreign` never paints red (see {@link ProbeOutcome}), so this line is the only thing the user
 * gets, and "not vite's ping" alone cannot separate the three causes it exists to tell apart: a
 * `200 text/html` means vite dropped the ping and infra-kit must ship a fix; a `502` means portless or a
 * proxy is shadowing the port; a `404` means a squatter won the free-port race. One glance, three very
 * different next moves — so the status and content-type travel with the verdict.
 */
export interface ForeignAnswer {
  kind: 'foreign'
  status: number
  contentType: string | null
}

/**
 * Three outcomes, not a boolean:
 * - `ok` — the endpoint PROVED it is serving (a 2xx on `/__health`; a 204 on vite's ping).
 * - `refused` — nothing answered (ECONNREFUSED, timeout, transport error).
 * - {@link ForeignAnswer} — something answered, but not the thing we asked for. For a backend that is a
 *   failure (our own fastify returning non-2xx). For a UI it is NOT: a non-204 is equally consistent with a
 *   squatter, with a proxy that shadows the ping, and with a future vite that dropped it — so it can never
 *   be allowed to paint red, and it is the reason this is not a boolean.
 */
export type ProbeOutcome = 'ok' | 'refused' | ForeignAnswer

/** Narrow a {@link ProbeOutcome} to the one arm that carries data. */
export const isForeign = (outcome: ProbeOutcome): outcome is ForeignAnswer => {
  return typeof outcome === 'object'
}

/** Build the `foreign` verdict from the response that earned it, draining its body so the socket returns. */
const foreignFrom = async (res: Response): Promise<ForeignAnswer> => {
  await res.body?.cancel()

  return { kind: 'foreign', status: res.status, contentType: res.headers.get('content-type') }
}

/**
 * The `◍ ?` warn. Names what answered instead of vite, because that is the whole actionable content: an
 * `html` body means vite dropped the ping (ours to fix), a 5xx means something is shadowing the port, a 404
 * means a squatter took it. The content-type is trimmed of its `; charset=…` tail — it is a hint, not a
 * header dump.
 */
export const describeForeign = (port: number, answer: ForeignAnswer): string => {
  const type = answer.contentType?.split(';')[0]?.trim()
  const what = type == null || type === '' ? `${answer.status}` : `${answer.status} ${type}`

  return `port ${port} answered ${what}, not vite's ping — liveness cannot be verified`
}

/** Health-probe seam: resolve one target's liveness. Injectable so the panel stays deterministic in tests. */
export type HealthProbe = (target: ProbeTarget) => Promise<ProbeOutcome>

/** One budget for the whole probe — BOTH hops of a UI redirect share it (see {@link probeUi}). */
const PROBE_TIMEOUT_MS = 1500

/**
 * Vite's HMR ping. It is installed unconditionally on every dev server (no plugin, no config) and it sits
 * AHEAD of vite's `htmlFallback` middleware — which is the whole point: `htmlFallback` answers a plain
 * `GET /` with `200 index.html` even for a vite whose entry module throws, so a naive GET would report a
 * broken app as healthy. The ping cannot be forged that way; a 204 means a vite dev server is listening.
 */
const VITE_PING_HEADERS = { accept: 'text/x-vite-ping' } as const

/**
 * Where a target is probed. Always `http://127.0.0.1:<port>`, never the `https://<alias>` the panel prints:
 * the alias adds TLS, a private CA and the portless daemon to the path, so a probe through it would report
 * the PROXY's health, not the app's. And never `localhost` — ServerlessLocalRun binds v4 loopback only,
 * while `localhost` resolves `[::1]` first on modern Node, which renders a healthy backend `● down`.
 */
const probeUrl = (target: ProbeTarget): string => {
  return target.kind === 'api' ? `http://127.0.0.1:${target.port}/__health` : `http://127.0.0.1:${target.port}/`
}

/** `new URL(loc, base)`, or `null` when the header is unparseable even relative to the probe URL. */
const resolveHop = (location: string, base: string): URL | null => {
  try {
    return new URL(location, base)
  } catch {
    return null
  }
}

/** A backend: `/__health` must answer 2xx. Anything else IS our own fastify failing, so it is not `ok`. */
const probeApi = async (url: string, signal: AbortSignal): Promise<ProbeOutcome> => {
  const res = await fetch(url, { signal })

  if (!res.ok) return foreignFrom(res)
  // Drain: undici keeps the socket checked out until an unread body is GC'd, and this runs every 5s per app
  // for the life of the session.
  await res.body?.cancel()

  return 'ok'
}

/**
 * A frontend: vite's ping must answer 204.
 *
 * The redirect hop is the delicate part. Vite serves the ping from its `base`, so a UI configured with
 * `base: '/app/'` answers `/` with a 3xx whose `Location` is RELATIVE (`/app/`) — which is why the hop is
 * resolved against the probe URL rather than parsed on its own (`new URL('/app/')` throws outright). The
 * accept header is RE-SENT on the second hop: without it the redirected request falls through to vite's
 * html fallback and comes back `200 text/html` — the exact false green this probe exists to refuse.
 *
 * Exactly one hop, same-origin only. A cross-origin redirect is somebody else's server, and a second hop
 * is a loop we have no budget for; both report `foreign` — never followed, and never called alive.
 */
const probeUi = async (url: string, signal: AbortSignal): Promise<ProbeOutcome> => {
  const res = await fetch(url, { headers: VITE_PING_HEADERS, redirect: 'manual', signal })

  if (res.status === 204) return 'ok'
  if (res.status < 300 || res.status >= 400) return foreignFrom(res)

  const location = res.headers.get('location')
  const next = location == null ? null : resolveHop(location, url)

  if (next == null || next.origin !== new URL(url).origin) return foreignFrom(res)

  await res.body?.cancel()

  const hop = await fetch(next, { headers: VITE_PING_HEADERS, redirect: 'manual', signal })

  if (hop.status !== 204) return foreignFrom(hop)
  await hop.body?.cancel()

  return 'ok'
}

/** Default probe: per-kind, bounded, and loopback-only. A transport error or a timeout is `refused`. */
export const defaultHealthProbe: HealthProbe = async (target: ProbeTarget): Promise<ProbeOutcome> => {
  const url = probeUrl(target)
  // ONE signal, shared across both hops: a redirect must not double the budget a wedged server can spend.
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)

  try {
    return target.kind === 'api' ? await probeApi(url, signal) : await probeUi(url, signal)
  } catch {
    return 'refused'
  }
}
