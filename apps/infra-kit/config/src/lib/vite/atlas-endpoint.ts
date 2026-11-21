import process from 'node:process'

export const ATLAS_PATH = '/__atlas'
export const ATLAS_ENV = 'INFRA_KIT_ATLAS'

export const ATLAS_TOKEN_HEADER = 'x-infra-kit-atlas-token'
export const ATLAS_SITE_HEADER = 'x-infra-kit-site'
export const ATLAS_SERVED_ROUTES_HEADER = 'x-infra-kit-served-routes'

export interface AtlasEndpoint {
  url: string
  token: string
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const LOOPBACK_URL_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/
const MAX_PORT = 65_535

export const serializeAtlasEndpoint = (endpoint: AtlasEndpoint): string => {
  return JSON.stringify({ url: endpoint.url, token: endpoint.token })
}

// The runner binds 127.0.0.1 only: `localhost` can resolve to ::1, and a token sent to any other
// host would leave the machine. Matched on the raw string because `URL` normalizes away default
// ports and trailing slashes, which would let a path-bearing value through.
const isLoopbackUrl = (url: string): boolean => {
  const match = LOOPBACK_URL_PATTERN.exec(url)

  return match !== null && Number(match[1]) <= MAX_PORT
}

/** Returns `null` for anything but a loopback `http` URL plus a 64-hex token; never throws. */
export const readAtlasEndpoint = (env: NodeJS.ProcessEnv = process.env): AtlasEndpoint | null => {
  const raw = env[ATLAS_ENV]

  if (!raw) {
    return null
  }

  let value: unknown

  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof value !== 'object' || value === null) {
    return null
  }

  const { url, token } = value as Record<string, unknown>

  if (typeof url !== 'string' || typeof token !== 'string') {
    return null
  }
  if (!TOKEN_PATTERN.test(token) || !isLoopbackUrl(url)) {
    return null
  }

  return { url, token }
}
