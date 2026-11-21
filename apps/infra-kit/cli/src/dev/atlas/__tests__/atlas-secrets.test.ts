import { ATLAS_SERVED_ROUTES_HEADER, ATLAS_SITE_HEADER, readAtlasEndpoint } from '@slip-stream-kit/config/internal'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AtlasRuntime } from 'src/dev/atlas/atlas-state'

import { CLOUD_ENV, PLANNED, makeAtlasRepo, makeFacts } from './atlas-fixture'
import type { AtlasRepo } from './atlas-fixture'
import { atlasRequest } from './atlas-http'

const SECRET_ENV: Record<string, string> = {
  E2E__BASIC_AUTH_USERNAME: 'u',
  E2E__BASIC_AUTH_PASSWORD: 'p',
  [CLOUD_ENV]: 'https://u:p@dev.example.com/x?token=abc',
}

const FORBIDDEN = [
  'u:p',
  Buffer.from('u:p').toString('base64'),
  'hunter2',
  'token=abc',
  'Authorization',
  'Bearer',
  '@dev.example.com',
]

let repo: AtlasRepo
let runtime: AtlasRuntime
const saved: Record<string, string | undefined> = {}

beforeEach(async () => {
  for (const [name, value] of Object.entries(SECRET_ENV)) {
    saved[name] = process.env[name]
    process.env[name] = value
  }
  repo = await makeAtlasRepo()
  repo.writeFragment('mine-api')
  repo.writeFragment('live-api')
})

afterEach(async () => {
  await runtime.close()
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  repo.cleanup()
})

describe('atlas — no secret reaches a response', () => {
  it('keeps every body and every header of all four endpoints clean', async () => {
    // `makeFacts` hands over a failed backend whose reason carries a DSN, a password and a bearer token.
    runtime = new AtlasRuntime({
      planned: PLANNED,
      facts: () => {
        return makeFacts(repo.logDir)
      },
      readAsset: (name) => {
        return Buffer.from(`/* ${name} */`)
      },
    })
    runtime.setUis([repo.ui])
    runtime.captureSpawnEnv({ ...process.env })
    await runtime.start()

    const endpoint = readAtlasEndpoint(runtime.endpointEnv())!

    const served = encodeURIComponent(
      JSON.stringify({
        '/api/cloud': { host: 'u:p@dev.example.com', user: false },
        '/api/live': { host: 'https://u:p@dev.example.com/?token=abc', user: false },
      }),
    )

    const headers = { [ATLAS_SITE_HEADER]: 'shop-ui', [ATLAS_SERVED_ROUTES_HEADER]: served }

    const responses = await Promise.all(
      ['/__atlas', '/__atlas/app.js', '/__atlas/app.css', '/__atlas/state.json'].map((path) => {
        return atlasRequest(endpoint, { path, headers })
      }),
    )

    const state = responses[3]!

    // The snapshot really did resolve the cloud route and the failed backend, so the scan is not vacuous.
    expect(state.status).toBe(200)
    expect(state.body).toContain('dev.example.com')
    expect(state.body).toContain('launched-failed')

    for (const res of responses) {
      const surface = [res.body, ...res.rawHeaders].join('\n')

      for (const needle of FORBIDDEN) expect(surface, `${needle} leaked`).not.toContain(needle)
    }
  })
})
