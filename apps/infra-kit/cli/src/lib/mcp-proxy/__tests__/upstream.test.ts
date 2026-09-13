import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ProxyVars } from '../env-vars'
import { createUpstream } from '../upstream'
import type { ProxySpec, Upstream } from '../upstream'

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-upstream.mjs')

const ALPHA: ProxyVars = { GRAFANA_URL: 'https://alpha.example', GRAFANA_SERVICE_ACCOUNT_TOKEN: 'token-alpha' }
const BRAVO: ProxyVars = { GRAFANA_URL: 'https://bravo.example', GRAFANA_SERVICE_ACCOUNT_TOKEN: 'token-bravo' }

/** The fixture speaks stdio and reports the two variables it was given, so specs point at it. */
const spec = (overrides: Partial<ProxySpec> = {}): ProxySpec => {
  return {
    name: 'fake',
    command: process.execPath,
    args: [FIXTURE],
    env: ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN'],
    unset: [],
    ...overrides,
  }
}

let dir = ''
let created: Upstream[] = []

interface SpawnRecord {
  pid: number
  url: string
  token: string
  tokenFile: string
  leaked: string
}

interface MethodRecord {
  method: string
  id?: number
}

const readLog = <T>(file: string): T[] => {
  if (!fs.existsSync(file)) return []

  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      return line.trim().length > 0
    })
    .map((line) => {
      return JSON.parse(line) as T
    })
}

const build = (extraEnv: NodeJS.ProcessEnv = {}, readyTimeoutMs = 5000): Upstream => {
  const upstream = createUpstream(spec(), {
    readyTimeoutMs,
    extraEnv: {
      FAKE_SPAWN_LOG: path.join(dir, 'spawns.jsonl'),
      FAKE_METHOD_LOG: path.join(dir, 'methods.jsonl'),
      ...extraEnv,
    },
  })

  created.push(upstream)

  return upstream
}

const spawns = (): SpawnRecord[] => {
  return readLog<SpawnRecord>(path.join(dir, 'spawns.jsonl'))
}

const methods = (): MethodRecord[] => {
  return readLog<MethodRecord>(path.join(dir, 'methods.jsonl'))
}

const textOf = (message: { result?: unknown }): string => {
  const result = message.result as { content?: { text?: string }[] } | undefined

  return result?.content?.[0]?.text ?? ''
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-upstream-'))
  created = []
})

afterEach(() => {
  for (const upstream of created) upstream.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('spawn lifecycle', () => {
  it('spawns lazily — a session that never calls Grafana spawns nothing', () => {
    build()

    expect(spawns()).toHaveLength(0)
  })

  it('spawns exactly one child for repeated calls with unchanged credentials', async () => {
    const upstream = build()

    await upstream.request({ id: 1, method: 'tools/list' }, ALPHA)
    await upstream.request({ id: 2, method: 'tools/list' }, ALPHA)
    await upstream.request({ id: 3, method: 'tools/call' }, ALPHA)

    expect(spawns()).toHaveLength(1)
  })

  it('replays initialize before any tools/call reaches the child', async () => {
    const upstream = build()

    await upstream.request({ id: 1, method: 'tools/call' }, ALPHA)

    expect(
      methods().map((entry) => {
        return entry.method
      }),
    ).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
  })

  it('replaces the upstream when GRAFANA_URL changes, and the call reaches the new one', async () => {
    const upstream = build()

    const first = await upstream.request({ id: 1, method: 'tools/call' }, ALPHA)
    const second = await upstream.request({ id: 2, method: 'tools/call' }, BRAVO)

    expect(textOf(first)).toContain('https://alpha.example')
    expect(textOf(second)).toContain('https://bravo.example')
    expect(spawns()).toHaveLength(2)
  })

  it('replaces the upstream when only the TOKEN changes — the Option D respawn', async () => {
    const upstream = build()

    const first = await upstream.request({ id: 1, method: 'tools/call' }, ALPHA)
    const rotated: ProxyVars = { ...ALPHA, GRAFANA_SERVICE_ACCOUNT_TOKEN: 'token-rotated' }
    const second = await upstream.request({ id: 2, method: 'tools/call' }, rotated)

    expect(textOf(first)).toContain('token-alpha')
    expect(textOf(second)).toContain('token-rotated')
    expect(spawns()).toHaveLength(2)
  })

  it('never puts the token in a file — it goes inline in the child environment', async () => {
    const upstream = build()

    await upstream.request({ id: 1, method: 'tools/call' }, ALPHA)

    const [record] = spawns()

    expect(record?.token).toBe('token-alpha')
    expect(record?.tokenFile, 'GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE must be cleared so no stale file can win').toBe('')

    const strays = fs.readdirSync(dir).filter((name) => {
      return name.startsWith('token')
    })

    expect(strays, 'the shim must write no credential to disk').toEqual([])
  })
})

describe('id namespace (N1)', () => {
  it('does not confuse a client request numbered 0 with the replayed handshake', async () => {
    const upstream = build()

    const response = await upstream.request({ id: 0, method: 'tools/call' }, ALPHA)

    // Mapped back to the client's own id...
    expect(response.id).toBe(0)
    expect(textOf(response)).toContain('https://alpha.example')

    // ...while on the wire the shim used ids from its OWN counter, so the handshake and
    // the client's id-0 request are distinct messages. A shared namespace would have
    // sent both as id 0 and made the handshake's answer indistinguishable.
    const wire = methods().filter((entry) => {
      return entry.method === 'initialize' || entry.method === 'tools/call'
    })

    expect(
      wire.map((entry) => {
        return entry.id
      }),
    ).toEqual([1, 2])
    expect(
      new Set(
        wire.map((entry) => {
          return entry.id
        }),
      ).size,
    ).toBe(wire.length)
  })

  it('never forwards the replayed handshake answer to the client', async () => {
    const relayed: unknown[] = []
    const upstream = createUpstream(spec(), {
      readyTimeoutMs: 5000,
      extraEnv: { FAKE_SPAWN_LOG: path.join(dir, 'spawns.jsonl'), FAKE_METHOD_LOG: path.join(dir, 'methods.jsonl') },
      onServerMessage: (message) => {
        relayed.push(message)
      },
    })

    created.push(upstream)

    const response = await upstream.request({ id: 7, method: 'tools/list' }, ALPHA)

    expect(response.id).toBe(7)
    expect(relayed, 'the handshake answer is consumed by the shim, never relayed').toEqual([])
  })

  it('relays a server-initiated notification to the client', async () => {
    const relayed: { method?: string }[] = []
    const upstream = createUpstream(spec(), {
      readyTimeoutMs: 5000,
      extraEnv: { FAKE_TAG: 'srv' },
      onServerMessage: (message) => {
        relayed.push(message)
      },
    })

    created.push(upstream)

    await upstream.request({ id: 1, method: 'emit/notification' }, ALPHA)

    expect(
      relayed.map((message) => {
        return message.method
      }),
      'Option A never opened a stream for these and dropped them silently',
    ).toEqual(['notifications/message'])
  })
})

describe('readiness (N2, M1)', () => {
  it('errors on a child that never answers initialize, instead of hanging', async () => {
    const upstream = build({ FAKE_NEVER_ANSWER_INIT: '1' }, 300)

    await expect(upstream.request({ id: 1, method: 'tools/list' }, ALPHA)).rejects.toThrow(/did not answer initialize/)
  })

  it('does not hang the NEXT request after a readiness failure', async () => {
    const upstream = build({ FAKE_NEVER_ANSWER_INIT: '1' }, 300)

    await expect(upstream.request({ id: 1, method: 'tools/list' }, ALPHA)).rejects.toThrow()
    await expect(upstream.request({ id: 2, method: 'tools/list' }, ALPHA)).rejects.toThrow()
  })

  it('a second request during a slow cold start waits for readiness and reuses the child (M1)', async () => {
    const upstream = build({ FAKE_INIT_DELAY_MS: '250' })

    const [first, second] = await Promise.all([
      upstream.request({ id: 1, method: 'tools/call' }, ALPHA),
      upstream.request({ id: 2, method: 'tools/call' }, ALPHA),
    ])

    expect(textOf(first)).toContain('https://alpha.example')
    expect(textOf(second)).toContain('https://alpha.example')
    expect(spawns(), 'a cold start must not be raced into a second spawn').toHaveLength(1)
    expect(methods()[0]?.method, 'nothing may be sent before the handshake answers').toBe('initialize')
  })
})

describe('swap safety (D6)', () => {
  it('binds to the NEW url when a change races an in-flight cold start, and errors the superseded caller', async () => {
    const upstream = build({ FAKE_INIT_DELAY_MS: '250' })

    const superseded = upstream.request({ id: 1, method: 'tools/call' }, ALPHA)
    const winner = upstream.request({ id: 2, method: 'tools/call' }, BRAVO)

    await expect(superseded, 'in-flight work is errored, never left hanging').rejects.toThrow(/superseded/)
    expect(textOf(await winner)).toContain('https://bravo.example')
  })

  it('errors in-flight requests when the upstream is disposed', async () => {
    const upstream = build()

    await upstream.request({ id: 1, method: 'tools/list' }, ALPHA)

    const pending = upstream.request({ id: 2, method: 'tools/call' }, ALPHA)

    upstream.dispose()

    // Which of the two rejection paths fires is a timing detail — the invariant is that
    // it REJECTS rather than leaving the caller pending for the rest of the session.
    await expect(pending).rejects.toThrow(/disposed|exited|closed/)
  })
})

describe('per-request deadline', () => {
  it('errors a request the child accepts and then never answers, instead of hanging forever', async () => {
    const upstream = createUpstream(spec(), {
      readyTimeoutMs: 5000,
      // The handshake succeeds; only the later call is swallowed. Before this deadline
      // existed the caller waited for the rest of the session with nothing to rescue it.
      requestTimeoutMs: 300,
      extraEnv: { FAKE_SILENT_METHODS: 'tools/call' },
    })

    created.push(upstream)

    await expect(upstream.request({ id: 1, method: 'tools/call' }, ALPHA)).rejects.toThrow(/did not answer tools\/call/)

    // And the session is still usable — a timeout is not a poisoned upstream.
    const survivor = await upstream.request({ id: 2, method: 'tools/list' }, ALPHA)

    expect(survivor.id).toBe(2)
  })
})

describe('child environment', () => {
  it('deletes the env file’s non-Grafana names from the inherited environment', async () => {
    const upstream = createUpstream(spec(), {
      readyTimeoutMs: 5000,
      extraEnv: {
        FAKE_SPAWN_LOG: path.join(dir, 'spawns.jsonl'),
        FAKE_LEAK_PROBE: 'HULYO_MONGODB_CONNECTION',
        // Present in the parent, exactly as it would be in a shell that sourced env-load.sh.
        HULYO_MONGODB_CONNECTION: 'mongodb://user:pw@host',
      },
      stripFromChildEnv: () => {
        return ['HULYO_MONGODB_CONNECTION']
      },
    })

    created.push(upstream)

    await upstream.request({ id: 1, method: 'tools/list' }, ALPHA)

    expect(
      spawns()[0]?.leaked,
      'the shim is launched from a shell holding every secret in the env file; the GRAFANA_ filter alone does not stop inheritance',
    ).toBe('')
  })
})

describe('server-initiated requests', () => {
  it('refuses them rather than relaying an id from the upstream’s namespace', async () => {
    const relayed: { method?: string }[] = []
    const upstream = createUpstream(spec(), {
      readyTimeoutMs: 5000,
      onServerMessage: (message) => {
        relayed.push(message)
      },
    })

    created.push(upstream)

    const response = await upstream.request({ id: 1, method: 'emit/request' }, ALPHA)

    expect(response.id).toBe(1)
    expect(
      relayed.map((message) => {
        return message.method
      }),
      'relaying it would send the client an id it does not own, and the client’s answer would re-enter as a request with no method',
    ).toEqual([])
  })
})

describe('child environment — what must survive redaction', () => {
  it('keeps PATH even when the env file names it, or the spawn would ENOENT', async () => {
    const upstream = createUpstream(spec(), {
      readyTimeoutMs: 5000,
      extraEnv: { FAKE_SPAWN_LOG: path.join(dir, 'spawns.jsonl') },
      // PATH is set by the shim itself immediately before the redaction loop; without
      // the never-strip set this deletes it again and the child cannot start.
      stripFromChildEnv: () => {
        return ['PATH', 'HTTPS_PROXY']
      },
    })

    created.push(upstream)

    const response = await upstream.request({ id: 1, method: 'tools/list' }, ALPHA)

    expect(response.id).toBe(1)
    expect(spawns()).toHaveLength(1)
  })
})

describe('the respawn key is every listed variable', () => {
  it('replaces the upstream when EITHER listed variable changes, and not when neither does', async () => {
    const upstream = build()

    await upstream.request({ id: 1, method: 'tools/call' }, ALPHA)
    await upstream.request({ id: 2, method: 'tools/call' }, { ...ALPHA })
    expect(spawns(), 'identical values must not respawn').toHaveLength(1)

    await upstream.request({ id: 3, method: 'tools/call' }, { ...ALPHA, GRAFANA_URL: 'https://other.example' })
    expect(spawns(), 'the first variable changing respawns').toHaveLength(2)

    await upstream.request(
      { id: 4, method: 'tools/call' },
      { GRAFANA_URL: 'https://other.example', GRAFANA_SERVICE_ACCOUNT_TOKEN: 'rotated' },
    )
    expect(spawns(), 'the second variable changing respawns').toHaveLength(3)
  })
})

describe('unset', () => {
  it('forces the named variables EMPTY in the child even when the parent has them', async () => {
    const upstream = createUpstream(spec({ unset: ['GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE'] }), {
      readyTimeoutMs: 5000,
      extraEnv: {
        FAKE_SPAWN_LOG: path.join(dir, 'spawns.jsonl'),
        FAKE_LEAK_PROBE: 'GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE',
        // As a parent shell that sourced an older env file would have it.
        GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE: '/stale/token/file',
      },
    })

    created.push(upstream)

    await upstream.request({ id: 1, method: 'tools/list' }, ALPHA)

    expect(spawns()[0]?.tokenFile, 'a stale file-based credential must never outrank the inline one').toBe('')
    expect(spawns()[0]?.leaked).toBe('')
  })
})
