/**
 * Ask the npm registry for the `latest` dist-tag. Node >= 24 (see `engines`), so global `fetch` is
 * available and this needs no dependency.
 */
import { PACKAGE_NAME } from 'src/lib/install-manager'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** Bounded so a hanging registry can never keep a detached child alive indefinitely. */
export const FETCH_TIMEOUT_MS = 2_500

/**
 * The registry this install actually talks to. A user behind a corporate mirror has `npm_config_registry`
 * set; hitting registry.npmjs.org directly would either fail closed (firewall) or, worse, report a public
 * version they cannot install.
 *
 * @example
 * registryUrl({ npm_config_registry: 'https://nexus.corp/repo/npm/' }) // => 'https://nexus.corp/repo/npm'
 */
export const registryUrl = (env: NodeJS.ProcessEnv): string => {
  const configured = env.npm_config_registry

  let base = configured != null && configured !== '' ? configured : DEFAULT_REGISTRY

  // A `/\/+$/` regex would do this in one line, but its backtracking is super-linear on a hostile input.
  while (base.endsWith('/')) {
    base = base.slice(0, -1)
  }

  return base
}

/**
 * The published `latest` version, or null on ANY failure (offline, timeout, non-200, malformed body).
 * Never throws: a failed check must be indistinguishable from "no update available" to every caller.
 *
 * @example
 * await fetchLatestVersion(process.env) // => '0.1.131' | null
 */
export const fetchLatestVersion = async (
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, FETCH_TIMEOUT_MS)

  try {
    const response = await fetchFn(`${registryUrl(env)}/${PACKAGE_NAME}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })

    if (!response.ok) return null

    const body: unknown = await response.json()
    const version = (body as { version?: unknown } | null)?.version

    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
