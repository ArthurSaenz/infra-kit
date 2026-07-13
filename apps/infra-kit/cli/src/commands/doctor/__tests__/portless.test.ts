import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { caFingerprintMatches, listRoutes, readCaPath } from 'src/dev/proxy/portless-driver'
import type { HandshakeResult, PortlessRoute } from 'src/dev/proxy/portless-driver'

import { checkPortless } from '../doctor'
import type { PortlessCheckDeps } from '../doctor'

/** The bin doctor's checks are told to build their remediations from — stands in for the real node_modules. */
const BIN = '/node_modules/portless/dist/cli.js'

/**
 * Every string doctor prints to tell a user to go fix something. The green-path test asserts that a healthy
 * machine sees NONE of them — the criterion that a probe which false-fails for every correctly-configured
 * user would violate (and which asserting only that failures FIRE cannot catch).
 *
 * They are matched on `<bin> <subcommand>` rather than on `portless <subcommand>` because that is the only
 * form a user can run: portless is not on PATH, so a bare `portless …` — and, under sudo's secure_path, even
 * a globally-installed one — fails with `command not found`.
 */
const REMEDIATIONS = [`${BIN} trust`, `${BIN} service install`, 'pnpm install', 'alias --remove']

/** The un-runnable forms. No check may ever print one of these again. */
const BARE_FORMS = ['sudo portless service install', 'portless trust', 'portless alias --remove']

const messagesOf = (checks: { message: string }[]): string => {
  return checks
    .map((check) => {
      return check.message
    })
    .join('\n')
}

const statusOf = (checks: { name: string; status: string }[], name: string): string | undefined => {
  return checks.find((check) => {
    return check.name.startsWith(name)
  })?.status
}

/** A machine where everything is right: portless present, serving TLS on :443, valid chain, trusted CA. */
const healthyDeps = (overrides: PortlessCheckDeps = {}): PortlessCheckDeps => {
  return {
    resolveBin: () => {
      return BIN
    },
    isProxyServing: () => {
      return Promise.resolve(true)
    },
    handshake: () => {
      return Promise.resolve<HandshakeResult>({ ok: true })
    },
    caTrusted: () => {
      return true
    },
    routes: (): PortlessRoute[] => {
      return []
    },
    isListening: () => {
      return Promise.resolve(true)
    },
    caPath: () => {
      return path.join(stateDir, 'ca.pem')
    },
    ...overrides,
  }
}

let stateDir = ''
let previousStateDir: string | undefined

/** Point the driver's real fs reads at a throwaway state dir so no test can touch `~/.portless`. */
const seedStateDir = (files: Record<string, string>): void => {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(stateDir, name), content)
  }
}

const sha256 = (content: string): string => {
  return createHash('sha256').update(content).digest('hex')
}

beforeEach(() => {
  previousStateDir = process.env.PORTLESS_STATE_DIR
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-portless-test-'))
  process.env.PORTLESS_STATE_DIR = stateDir
})

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.PORTLESS_STATE_DIR
  else process.env.PORTLESS_STATE_DIR = previousStateDir
  fs.rmSync(stateDir, { recursive: true, force: true })
})

describe('checkPortless', () => {
  it('reports five passes and NOT ONE remediation on a healthy, correctly-trusted machine', async () => {
    const checks = await checkPortless(healthyDeps())

    expect(checks).toHaveLength(5)
    expect(
      checks.filter((check) => {
        return check.status !== 'pass'
      }),
    ).toEqual([])

    const printed = messagesOf(checks)

    for (const remediation of REMEDIATIONS) {
      expect(printed).not.toContain(remediation)
    }
  })

  it('blames only the trust store when the CA is untrusted — the daemon checks still pass', async () => {
    const checks = await checkPortless(
      healthyDeps({
        caTrusted: () => {
          return false
        },
      }),
    )

    expect(statusOf(checks, 'portless serving TLS')).toBe('pass')
    expect(statusOf(checks, 'portless CA chain valid')).toBe('pass')
    expect(statusOf(checks, 'portless CA trusted')).toBe('fail')

    const printed = messagesOf(checks)

    // The sudo-free fix, and ONLY the sudo-free fix: an untrusted CA never warrants a root reinstall.
    expect(printed).toContain(`${BIN} trust`)
    expect(printed).toContain('no sudo needed')
    expect(printed).not.toContain(`${BIN} service install`)
  })

  it('does not lie when portless clobbers its process-global state markers', async () => {
    // portless's `resolveStateDir(_port)` ignores its port arg, so ANY daemon start/stop rewrites these for
    // EVERY daemon. Here they claim a plain-HTTP daemon on another port while :443 provably serves TLS.
    seedStateDir({
      'proxy.port': '1355',
      'proxy.tls': 'false',
      'proxy.pid': '4242',
      'ca.pem': 'CA-BYTES',
      'ca.trusted': `${sha256('CA-BYTES')}\n`,
    })

    // Only the wire seams are injected: the CA checks read the (clobbered) real state dir on disk.
    const checks = await checkPortless({
      resolveBin: () => {
        return BIN
      },
      isProxyServing: (port, tls) => {
        return Promise.resolve(port === 443 && tls)
      },
      handshake: () => {
        return Promise.resolve<HandshakeResult>({ ok: true })
      },
    })

    expect(statusOf(checks, 'portless serving TLS')).toBe('pass')
    expect(statusOf(checks, 'portless CA chain valid')).toBe('pass')
    expect(statusOf(checks, 'portless CA trusted')).toBe('pass')

    const printed = messagesOf(checks)

    expect(printed).not.toContain('No portless daemon')
    expect(printed).not.toContain('reinstall')
    expect(printed).not.toContain(`${BIN} service install`)
  })

  it('never tells the user to run `portless trust` when OUR probe forgot a servername', async () => {
    const checks = await checkPortless(
      healthyDeps({
        handshake: () => {
          return Promise.resolve<HandshakeResult>({ ok: false, code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
        },
      }),
    )

    const chain = checks.find((check) => {
      return check.name === 'portless CA chain valid'
    })

    expect(chain?.status).toBe('fail')
    expect(chain?.message).toContain('ERR_TLS_CERT_ALTNAME_INVALID')
    expect(chain?.message).toContain('Internal check error')
    expect(messagesOf(checks)).not.toContain(`${BIN} trust`)
  })

  it('tells the user to run `portless trust` when the served cert does not chain to our CA', async () => {
    const checks = await checkPortless(
      healthyDeps({
        handshake: () => {
          return Promise.resolve<HandshakeResult>({ ok: false, code: 'SELF_SIGNED_CERT_IN_CHAIN' })
        },
      }),
    )

    const chain = checks.find((check) => {
      return check.name === 'portless CA chain valid'
    })

    expect(chain?.status).toBe('fail')
    expect(chain?.message).toContain('does not chain to')
    expect(chain?.message).toContain(`${BIN} trust`)
  })

  it('validates a registered alias alongside `localhost`', async () => {
    const probed: string[] = []

    await checkPortless(
      healthyDeps({
        routes: () => {
          return [{ name: '2-4.client-api.localhost', port: 5100 }]
        },
        handshake: (_port, servername) => {
          probed.push(servername)

          return Promise.resolve<HandshakeResult>({ ok: true })
        },
      }),
    )

    expect(probed).toContain('localhost')
    expect(probed).toContain('2-4.client-api.localhost')
  })

  it('skips the chain check rather than piling a derivative failure on a down daemon', async () => {
    const checks = await checkPortless(
      healthyDeps({
        isProxyServing: () => {
          return Promise.resolve(false)
        },
      }),
    )

    expect(statusOf(checks, 'portless serving TLS')).toBe('fail')
    expect(statusOf(checks, 'portless CA chain valid')).toBe('pass')

    const printed = messagesOf(checks)

    expect(printed).toContain(`${BIN} service install`)
    // A down daemon is not evidence about the trust store.
    expect(printed).not.toContain(`${BIN} trust`)
  })

  it('reports stale routes by name', async () => {
    const checks = await checkPortless(
      healthyDeps({
        routes: () => {
          return [
            { name: 'live.api.localhost', port: 5100 },
            { name: 'dead.ui.localhost', port: 5200 },
          ]
        },
        isListening: (port) => {
          return Promise.resolve(port === 5100)
        },
      }),
    )

    const routes = checks.find((check) => {
      return check.name === 'portless routes'
    })

    expect(routes?.status).toBe('fail')
    expect(routes?.message).toContain('1 stale portless route(s): dead.ui.localhost')
    expect(routes?.message).toContain(`${BIN} alias --remove`)
  })

  it('prints only commands that can actually run — never a bare `portless`, under sudo or otherwise', async () => {
    // The regression this pins: doctor told users to run `sudo portless service install`, which dies with
    // `sudo: portless: command not found`. portless is an npm dep in node_modules, never on PATH — and sudo
    // replaces PATH with secure_path, so even a global install would not rescue the bare form. Every
    // remediation must therefore name the interpreter and the resolved cli.js by absolute path.
    const checks = await checkPortless(
      healthyDeps({
        isProxyServing: () => {
          return Promise.resolve(false)
        },
        caTrusted: () => {
          return false
        },
        routes: () => {
          return [{ name: 'dead.ui.localhost', port: 5200 }]
        },
        isListening: () => {
          return Promise.resolve(false)
        },
      }),
    )
    const printed = messagesOf(checks)

    for (const bare of BARE_FORMS) {
      expect(printed).not.toContain(bare)
    }

    // The install is the one command that needs root, and it is elevated as `sudo <node> <cli.js> …` —
    // sudo resolving an absolute interpreter, not a name it would have to look up on a PATH it just discarded.
    expect(printed).toContain(`sudo ${process.execPath} ${BIN} service install`)
    expect(printed).toContain(`${BIN} trust`)
    expect(printed).toContain(`${BIN} alias --remove`)
  })

  it('short-circuits to a single install check when portless is not resolvable', async () => {
    const checks = await checkPortless(
      healthyDeps({
        resolveBin: () => {
          return null
        },
      }),
    )

    expect(checks).toHaveLength(1)
    expect(checks[0]?.status).toBe('fail')
    expect(checks[0]?.message).toContain('pnpm install')
  })
})

describe('portless state-dir readers', () => {
  it('matches the CA fingerprint recorded by `portless trust`', () => {
    seedStateDir({ 'ca.pem': 'CA-BYTES', 'ca.trusted': `${sha256('CA-BYTES')}\n` })

    expect(readCaPath()).toBe(path.join(stateDir, 'ca.pem'))
    expect(caFingerprintMatches()).toBe(true)
  })

  it('reports untrusted when the marker is absent or the CA was regenerated', () => {
    seedStateDir({ 'ca.pem': 'CA-BYTES' })
    expect(caFingerprintMatches()).toBe(false)

    seedStateDir({ 'ca.trusted': `${sha256('OLD-CA-BYTES')}\n` })
    expect(caFingerprintMatches()).toBe(false)
  })

  it('parses routes.json and degrades to [] on anything unreadable', () => {
    expect(listRoutes()).toEqual([])

    seedStateDir({
      'routes.json': JSON.stringify([
        { hostname: '2-4.client-api.localhost', port: 5100, pid: 0 },
        { hostname: 'bogus.localhost' },
      ]),
    })
    expect(listRoutes()).toEqual([{ name: '2-4.client-api.localhost', port: 5100 }])

    seedStateDir({ 'routes.json': 'not json' })
    expect(listRoutes()).toEqual([])
  })

  it('reads the state dir from PORTLESS_STATE_DIR, never the real ~/.portless', () => {
    const real = path.join(os.homedir(), '.portless', 'routes.json')
    const before = fs.existsSync(real) ? fs.readFileSync(real, 'utf-8') : null

    seedStateDir({ 'routes.json': JSON.stringify([{ hostname: 'tmp.localhost', port: 1234, pid: 0 }]) })

    expect(listRoutes()).toEqual([{ name: 'tmp.localhost', port: 1234 }])
    expect(readCaPath().startsWith(stateDir)).toBe(true)

    const after = fs.existsSync(real) ? fs.readFileSync(real, 'utf-8') : null

    expect(after).toBe(before)
  })
})
