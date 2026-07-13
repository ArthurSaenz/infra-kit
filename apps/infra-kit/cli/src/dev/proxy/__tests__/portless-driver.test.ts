import { execFile } from 'node:child_process'
import fs, { existsSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'

import {
  createPortlessDriver,
  defaultIsListening,
  defaultIsProxyServing,
  formatPortlessCommand,
  resolvePortlessBin,
} from 'src/dev/proxy/portless-driver'
import type { PortlessRun } from 'src/dev/proxy/portless-driver'
import { withoutPackageManagerEnv } from 'src/lib/pm-env'

/**
 * The driver is pure process I/O over injected seams (`run` for awaited commands, `isProxyServing` for the
 * wire probe). Tests capture the exact portless argv and assert the best-effort contract: a failing/absent
 * binary degrades to a no-op, never a throw.
 */
const okRun: PortlessRun = () => {
  return Promise.resolve()
}

/** A `run` seam that records every argv it was called with. */
const recordingRun = (): { run: PortlessRun; calls: string[][] } => {
  const calls: string[][] = []
  const run: PortlessRun = (args) => {
    calls.push(args)

    return Promise.resolve()
  }

  return { run, calls }
}

describe('portless driver — binary resolution', () => {
  it('resolves the portless CLI from node_modules to a real file, independent of PATH', () => {
    // Regression: the driver used to shell out to a bare `portless` on PATH, which is only present when
    // `dev` is launched via pnpm/npm — so a global bin / cmux / foreign-cwd launch never found it and the
    // proxy silently no-op'd. It's a normal dependency; we must resolve its own dist/cli.js from disk.
    const bin = resolvePortlessBin()

    expect(bin).not.toBeNull()
    expect(bin).toMatch(/portless[/\\]dist[/\\]cli\.js$/)
    expect(existsSync(bin!)).toBe(true)
  })
})

describe('portless driver — formatPortlessCommand (the printed fix must RUN)', () => {
  /**
   * The bug this exists for: infra-kit printed `sudo portless service install`, and users got
   * `sudo: portless: command not found`. portless is an npm dependency in `node_modules`, so it is on PATH
   * only inside a pnpm/npm script — and `sudo` discards PATH for `secure_path` anyway, which is why even a
   * global install would not have saved the bare form. The printed command must therefore name the
   * interpreter and portless's own `cli.js` by absolute path, exactly as the driver itself invokes them.
   */
  const BIN = '/repo/node_modules/portless/dist/cli.js'
  const NODE = '/usr/local/bin/node'

  it('elevates the install as `sudo <node> <cli.js> service install` — no bare `portless` anywhere', () => {
    const cmd = formatPortlessCommand(['service', 'install'], { sudo: true, bin: BIN, execPath: NODE })

    expect(cmd).toBe(`sudo ${NODE} ${BIN} service install`)
    expect(cmd).not.toContain('sudo portless')
  })

  it('omits sudo for the commands that do not need root', () => {
    expect(formatPortlessCommand(['trust'], { bin: BIN, execPath: NODE })).toBe(`${NODE} ${BIN} trust`)
    expect(formatPortlessCommand(['alias', '--remove', 'x.localhost'], { bin: BIN, execPath: NODE })).toBe(
      `${NODE} ${BIN} alias --remove x.localhost`,
    )
  })

  it('quotes paths a shell would otherwise split — a repo under `~/My Projects` is not exotic', () => {
    const spaced = '/Users/dev/My Projects/repo/node_modules/portless/dist/cli.js'
    const cmd = formatPortlessCommand(['trust'], { bin: spaced, execPath: NODE })

    expect(cmd).toBe(`${NODE} '${spaced}' trust`)
  })

  it('produces a string a real shell actually executes', async () => {
    // The end-to-end proof: take what we would print, hand it to `sh -c` verbatim, and require portless to
    // answer. A command that only LOOKS right is exactly what shipped last time.
    const bin = resolvePortlessBin()

    expect(bin).not.toBeNull()

    const { stdout } = await promisify(execFile)('sh', ['-c', formatPortlessCommand(['--version'], { bin: bin! })])

    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  }, 20000)
})

describe('portless driver — argv contract', () => {
  it('registers an alias as `alias <name> <port>`', async () => {
    const { run, calls } = recordingRun()
    const driver = createPortlessDriver({ run })

    await driver.registerAlias('feat-x.client-api', 57076)
    // First call is the memoized `--version` availability probe; then the alias.
    expect(calls).toContainEqual(['alias', 'feat-x.client-api', '57076'])
    expect(calls[0]).toEqual(['--version'])
  })

  it('removes an alias as `alias --remove <name>`', async () => {
    const { run, calls } = recordingRun()
    const driver = createPortlessDriver({ run })

    await driver.removeAlias('feat-x.client-api')
    expect(calls).toContainEqual(['alias', '--remove', 'feat-x.client-api'])
  })
})

describe('portless driver — isProxyServing (probe only, never starts)', () => {
  it('is true when the wire probe identifies portless on the port', async () => {
    const driver = createPortlessDriver({
      run: okRun,
      isListening: () => {
        return Promise.resolve(true)
      },
      isProxyServing: () => {
        return Promise.resolve(true)
      },
    })

    await expect(driver.isProxyServing(443, true)).resolves.toBe(true)
  })

  it('is false when nothing is listening — the TCP pre-filter short-circuits the wire probe', async () => {
    let probed = false
    const driver = createPortlessDriver({
      run: okRun,
      isListening: () => {
        return Promise.resolve(false)
      },
      isProxyServing: () => {
        probed = true

        return Promise.resolve(true)
      },
    })

    await expect(driver.isProxyServing(443, true)).resolves.toBe(false)
    expect(probed).toBe(false)
  })

  it('rejects a squatter: something IS listening, but it is not portless', async () => {
    // A TCP probe alone cannot tell portless from an unrelated process holding the port. Registering
    // aliases into a route table nobody serves would publish hero URLs that never resolve, so an
    // unidentified listener is reported unusable.
    const driver = createPortlessDriver({
      run: okRun,
      isListening: () => {
        return Promise.resolve(true)
      },
      isProxyServing: () => {
        return Promise.resolve(false)
      },
    })

    await expect(driver.isProxyServing(443, true)).resolves.toBe(false)
  })

  it('forwards the tls flag to the probe — a plain-HTTP daemon on :443 must not pass as HTTPS', async () => {
    const seen: Array<[number, boolean]> = []
    const driver = createPortlessDriver({
      run: okRun,
      isListening: () => {
        return Promise.resolve(true)
      },
      isProxyServing: (port, tls) => {
        seen.push([port, tls])

        return Promise.resolve(true)
      },
    })

    await driver.isProxyServing(443, true)
    expect(seen).toEqual([[443, true]])
  })
})

describe('portless driver — best-effort degradation', () => {
  it('reports unavailable and no-ops every call when the binary is absent', async () => {
    const failRun: PortlessRun = () => {
      return Promise.reject(new Error('portless: not found'))
    }
    const driver = createPortlessDriver({ run: failRun })

    await expect(driver.isAvailable()).resolves.toBe(false)
    // None of these throw; ensure/register report failure.
    await expect(driver.isProxyServing(443, true)).resolves.toBe(false)
    await expect(driver.registerAlias('x.y', 1)).resolves.toBe(false)
    await expect(driver.removeAlias('x.y')).resolves.toBeUndefined()
  })

  it('memoizes availability — the binary is probed at most once', async () => {
    const run = vi.fn<PortlessRun>(() => {
      return Promise.resolve()
    })
    const driver = createPortlessDriver({ run })

    await driver.isAvailable()
    await driver.isAvailable()
    const versionCalls = run.mock.calls.filter(([args]) => {
      return args[0] === '--version'
    })

    expect(versionCalls).toHaveLength(1)
  })

  it('a wedged (rejecting) alias call degrades to a no-op, never throws', async () => {
    const run: PortlessRun = (args) => {
      if (args[0] === 'alias') return Promise.reject(new Error('timeout'))

      return Promise.resolve()
    }
    const driver = createPortlessDriver({ run })

    await expect(driver.registerAlias('x.y', 1)).resolves.toBe(false)
  })
})

describe('portless driver — default TCP liveness probe (real seam)', () => {
  // Exercises the ACTUAL probe (not an injected stub) so a broken/absent `net` connect can't ship green —
  // the exact "vitest passes, production probe broken" trap. Uses a real ephemeral loopback server.
  it('resolves true against a listening port and false once it is closed', async () => {
    const server = net.createServer()
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()

        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
      })
    })

    try {
      await expect(defaultIsListening(port)).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }

    // Same port, now closed → connect refused → false.
    await expect(defaultIsListening(port)).resolves.toBe(false)
  })
})

describe('defaultIsProxyServing — wire-probe identity (real seam)', () => {
  /*
   * Drives the REAL probe against a REAL server, because this is precisely where the "green unit test,
   * broken in production" trap lives: an injected stub would pass no matter what the probe actually sends.
   *
   * The probe replaces a state-file check (`proxy.port` + `proxy.pid`) that was unsound: portless's
   * `resolveStateDir(_port)` ignores its port argument, so those files are process-global singletons —
   * ANY daemon's start rewrites them and ANY daemon's stop deletes them. Both were reproduced against
   * portless 0.15.1 (see `.omc/research/portless-https-spike.md`), which is why identity must be proven on
   * the wire instead. The `serves no state files at all` case below is that regression, pinned.
   */
  const withServer = async (
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    body: (port: number) => Promise<void>,
  ): Promise<void> => {
    const server = http.createServer(handler)
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()

        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
      })
    })

    try {
      await body(port)
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  }

  it('is true when the listener sets the X-Portless header', async () => {
    await withServer(
      (_req, res) => {
        res.setHeader('X-Portless', '1')
        res.end()
      },
      async (port) => {
        await expect(defaultIsProxyServing(port, false)).resolves.toBe(true)
      },
    )
  })

  it('is true even on a 404 — portless sets the header BEFORE route lookup, so an unrouted host still answers', async () => {
    // The probe must not depend on any alias being registered: on a fresh machine there are none, and
    // doctor still has to be able to say "the daemon is up".
    await withServer(
      (_req, res) => {
        res.setHeader('X-Portless', '1')
        res.statusCode = 404
        res.end()
      },
      async (port) => {
        await expect(defaultIsProxyServing(port, false)).resolves.toBe(true)
      },
    )
  })

  it('is false for a squatter — an HTTP server that answers but is not portless', async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 200
        res.end()
      },
      async (port) => {
        await expect(defaultIsProxyServing(port, false)).resolves.toBe(false)
      },
    )
  })

  it('is false when nothing is listening at all', async () => {
    const server = net.createServer()
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()

        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
      })
    })

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })

    await expect(defaultIsProxyServing(port, false)).resolves.toBe(false)
  })

  it('reports a healthy daemon as SERVING even when portless state files name another port, or are absent', async () => {
    // THE regression this probe exists for. portless's markers are process-global singletons: starting any
    // other daemon rewrites `proxy.port`, and stopping any daemon deletes it outright. The old identity
    // check read those files and would therefore declare THIS healthy, responding daemon dead.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portless-state-'))
    const saved = process.env.PORTLESS_STATE_DIR

    process.env.PORTLESS_STATE_DIR = stateDir
    try {
      // Markers that describe some *other* daemon (the clobber), then no markers at all (the delete).
      fs.writeFileSync(path.join(stateDir, 'proxy.port'), '1355')
      fs.writeFileSync(path.join(stateDir, 'proxy.pid'), '2147483646') // long-dead pid

      await withServer(
        (_req, res) => {
          res.setHeader('X-Portless', '1')
          res.end()
        },
        async (port) => {
          expect(port).not.toBe(1355)
          await expect(defaultIsProxyServing(port, false)).resolves.toBe(true)

          fs.rmSync(path.join(stateDir, 'proxy.port'))
          fs.rmSync(path.join(stateDir, 'proxy.pid'))
          await expect(defaultIsProxyServing(port, false)).resolves.toBe(true)
        },
      )
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true })
      if (saved === undefined) delete process.env.PORTLESS_STATE_DIR
      else process.env.PORTLESS_STATE_DIR = saved
    }
  })
})

describe('portless driver — child env sanitising', () => {
  it('strips every npm_* key so portless does not mistake `pnpm exec` for `pnpm dlx`', () => {
    const sanitised = withoutPackageManagerEnv({
      npm_command: 'exec',
      npm_config_user_agent: 'pnpm/11.10.0',
      npm_lifecycle_event: 'dev',
      PATH: '/usr/bin',
      HOME: '/Users/dev',
    })

    expect(sanitised).toStrictEqual({ PATH: '/usr/bin', HOME: '/Users/dev' })
  })

  it('also strips PNPM_SCRIPT_SRC_DIR — dropping npm_lifecycle_event alone would ARM the dlx guard', () => {
    // portless: isPnpmDlx = !!PNPM_SCRIPT_SRC_DIR && !npm_lifecycle_event. A script-style launch sets
    // BOTH, and the lifecycle event is what keeps the guard asleep. Strip only the `npm_*` block and we
    // remove the suppressor while leaving the trigger — turning a working invocation into an abort.
    const sanitised = withoutPackageManagerEnv({
      npm_lifecycle_event: 'dev',
      PNPM_SCRIPT_SRC_DIR: '/repo',
      PATH: '/usr/bin',
    })

    expect(sanitised).toStrictEqual({ PATH: '/usr/bin' })
  })

  it('leaves an already-clean env untouched', () => {
    const env = { PATH: '/usr/bin', PORTLESS_SYNC_HOSTS: '0' }

    expect(withoutPackageManagerEnv(env)).toStrictEqual(env)
  })
})

describe('portless driver — default run seam vs the real portless guard (end-to-end)', () => {
  /*
   * These drive the ACTUAL `defaultRun` (no injected `run`) against the REAL binary — the same
   * "green unit test, broken in production" trap the TCP-probe suite guards. `withoutPackageManagerEnv`
   * being correct in isolation proves nothing if `defaultRun` forgets to pass it as the child env.
   *
   * portless only arms its guard when `isLocallyInstalled()` is false, and that walks up from the
   * CHILD's cwd. Under vitest the cwd is the CLI package, which HAS node_modules/portless — so the guard
   * would never fire and the test would pass no matter what. We must chdir into a temp dir with no
   * portless above it to reproduce a consumer repo, where portless is a transitive dep absent from the
   * root node_modules. (`resolvePortlessBin` walks from the module file, not cwd, so the bin still resolves.)
   */
  const withEnvAndCwd = async (env: Record<string, string>, body: () => Promise<void>): Promise<void> => {
    const keys = ['npm_command', 'npm_config_user_agent', 'npm_lifecycle_event', 'PNPM_SCRIPT_SRC_DIR']
    const saved = Object.fromEntries(
      keys.map((k) => {
        return [k, process.env[k]]
      }),
    )
    const cwd = process.cwd()
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'portless-guard-'))

    for (const k of keys) delete process.env[k]
    Object.assign(process.env, env)
    process.chdir(temp)
    try {
      await body()
    } finally {
      process.chdir(cwd)
      fs.rmSync(temp, { recursive: true, force: true })
      for (const k of keys) {
        if (saved[k] == null) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  }

  it('survives an exec-style launch (`pnpm exec infra-kit dev`) that would otherwise abort', async () => {
    // Raw, this env is `isNpx` → portless exits 1 → isAvailable() false → hero URLs silently degrade.
    await withEnvAndCwd({ npm_command: 'exec', npm_config_user_agent: 'pnpm/10.0.0' }, async () => {
      await expect(createPortlessDriver({ timeoutMs: 15000 }).isAvailable()).resolves.toBe(true)
    })
  }, 20000)

  it('survives a script-style launch (PNPM_SCRIPT_SRC_DIR + npm_lifecycle_event)', async () => {
    // Regression for the half-fix: stripping `npm_*` but keeping PNPM_SCRIPT_SRC_DIR makes this abort.
    await withEnvAndCwd(
      { npm_command: 'run-script', npm_lifecycle_event: 'dev', PNPM_SCRIPT_SRC_DIR: '/repo' },
      async () => {
        await expect(createPortlessDriver({ timeoutMs: 15000 }).isAvailable()).resolves.toBe(true)
      },
    )
  })

  it('confirms the guard is genuinely armed here — an unsanitised exec-style env DOES abort', async () => {
    // Without this, the two tests above could pass vacuously (guard asleep) and never catch a regression.
    await withEnvAndCwd({ npm_command: 'exec' }, async () => {
      const bin = resolvePortlessBin()!
      const raw: PortlessRun = async (args) => {
        await promisify(execFile)(process.execPath, [bin, ...args], { env: process.env, encoding: 'utf-8' })
      }

      await expect(createPortlessDriver({ run: raw }).isAvailable()).resolves.toBe(false)
    })
  }, 20000)
})
