import { describe, expect, it } from 'vitest'

import { ATLAS_ENV, readAtlasEndpoint, serializeAtlasEndpoint } from '../atlas-endpoint'

const TOKEN = 'a1'.repeat(32)
const URL_OK = 'http://127.0.0.1:4321'

const envOf = (value: unknown): NodeJS.ProcessEnv => {
  return {
    [ATLAS_ENV]: typeof value === 'string' ? value : JSON.stringify(value),
  }
}

describe('atlas endpoint', () => {
  it('round-trips a serialized endpoint', () => {
    const env = { [ATLAS_ENV]: serializeAtlasEndpoint({ url: URL_OK, token: TOKEN }) }

    expect(readAtlasEndpoint(env)).toEqual({ url: URL_OK, token: TOKEN })
  })

  it.each([
    // The reader must refuse non-loopback hosts, so a clear-text URL is the fixture.
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fixture for a rejected host
    ['non-loopback host', 'http://192.168.1.5:4321'],
    ['localhost host', 'http://localhost:4321'],
    ['https scheme', 'https://127.0.0.1:4321'],
    ['path', 'http://127.0.0.1:4321/x'],
    ['trailing slash', 'http://127.0.0.1:4321/'],
    ['query', 'http://127.0.0.1:4321?a=1'],
    ['userinfo', 'http://user:pw@127.0.0.1:4321'],
    ['missing port', 'http://127.0.0.1'],
    ['port zero', 'http://127.0.0.1:0'],
    ['port out of range', 'http://127.0.0.1:70000'],
    ['non-URL', 'nope'],
  ])('rejects a %s', (_label, url) => {
    expect(readAtlasEndpoint(envOf({ url, token: TOKEN }))).toBeNull()
  })

  it.each([
    ['short', 'abc123'],
    ['non-hex', 'z'.repeat(64)],
    ['uppercase hex', 'A'.repeat(64)],
    ['too long', 'a'.repeat(65)],
  ])('rejects a %s token', (_label, token) => {
    expect(readAtlasEndpoint(envOf({ url: URL_OK, token }))).toBeNull()
  })

  it.each([
    ['malformed JSON', '{not json'],
    ['a JSON scalar', '42'],
    ['JSON null', 'null'],
  ])('rejects %s', (_label, raw) => {
    expect(readAtlasEndpoint(envOf(raw))).toBeNull()
  })

  it('rejects non-string fields', () => {
    expect(readAtlasEndpoint(envOf({ url: 1, token: TOKEN }))).toBeNull()
  })

  it('returns null when the variable is absent or empty', () => {
    expect(readAtlasEndpoint({})).toBeNull()
    expect(readAtlasEndpoint({ [ATLAS_ENV]: '' })).toBeNull()
  })
})
