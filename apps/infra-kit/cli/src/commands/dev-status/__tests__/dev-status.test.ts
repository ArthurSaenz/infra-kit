import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logger } from 'src/lib/logger'
// Imported through the MCP resource's OWN specifier, not from `src/lib/dev-context` directly. That is
// the path `mcp/resources/index.ts` uses, so if the shim is ever replaced by a fresh implementation the
// agreement test below breaks — which is the whole point of it.
import { readDevContext } from 'src/mcp/resources/dev-context'

import { devStatus } from '../dev-status'

/**
 * A dev-server fragment as the runner writes it, minus the mtime (which the filesystem owns). `writeFragment`
 * drops it at `<cwd>/.infra-kit/dev-context/<app>.json`.
 */
const FRAGMENT_BASE = {
  v: 2,
  package: '@acme/web',
  port: 5173,
  pid: 4242,
  writtenAt: 1_700_000_000_000,
  release: 'main',
  alias: 'main.acme-web.localhost',
  origin: 'https://main.acme-web.localhost',
}

let tmpRoot: string

const devContextDir = (): string => {
  return path.join(tmpRoot, '.infra-kit', 'dev-context')
}

const writeFragment = (app: string, overrides: Partial<typeof FRAGMENT_BASE> = {}): string => {
  const dir = devContextDir()

  fs.mkdirSync(dir, { recursive: true })

  const file = path.join(dir, `${app}.json`)

  fs.writeFileSync(file, JSON.stringify({ ...FRAGMENT_BASE, ...overrides }, null, 2))

  return file
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-status-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('devStatus', () => {
  it('reflects seeded fragments on disk WITHOUT spawning a server (only the injected probe runs)', async () => {
    writeFragment('web', { package: '@acme/web', port: 5173 })
    writeFragment('api', { package: '@acme/api', port: 8080, alias: 'main.acme-api.localhost' })

    // Injected probe: the ONLY liveness signal. If dev-status tried to start anything, this stub would not
    // be the sole source of `live`, and there is no process spawn seam to reach anyway.
    const probed: number[] = []
    const isListening = vi.fn(async (port: number) => {
      probed.push(port)

      return port === 5173 // web up, api down
    })

    const result = await devStatus({
      cwd: tmpRoot,
      isListening,
      now: () => {
        return FRAGMENT_BASE.writtenAt
      },
    })

    expect(result.structuredContent.active).toBe(true)
    expect(result.structuredContent.apps).toHaveLength(2)

    // Probe was asked about exactly the fragment ports — liveness is never asserted un-probed.
    expect(probed.sort()).toEqual([5173, 8080])

    const web = result.structuredContent.apps.find((a) => {
      return a.app === 'web'
    })!
    const api = result.structuredContent.apps.find((a) => {
      return a.app === 'api'
    })!

    expect(web.package).toBe('@acme/web')
    expect(web.port).toBe(5173)
    expect(web.origin).toBe('https://main.acme-web.localhost')
    expect(web.live).toBe(true)

    expect(api.port).toBe(8080)
    expect(api.live).toBe(false)
  })

  it('sorts apps by name and never lets the real network decide (probe is fully injected)', async () => {
    writeFragment('zeta', { port: 1 })
    writeFragment('alpha', { port: 2 })

    const isListening = vi.fn(async () => {
      return false
    })

    const result = await devStatus({
      cwd: tmpRoot,
      isListening,
      now: () => {
        return FRAGMENT_BASE.writtenAt
      },
    })

    expect(
      result.structuredContent.apps.map((a) => {
        return a.app
      }),
    ).toEqual(['alpha', 'zeta'])
  })

  it('returns a clean empty result when there is no dev session (missing dir), not an error', async () => {
    const isListening = vi.fn(async () => {
      return true
    })

    // No fragments written at all — the dev-context dir does not exist.
    const result = await devStatus({ cwd: tmpRoot, isListening })

    expect(result.structuredContent.active).toBe(false)
    expect(result.structuredContent.apps).toEqual([])
    expect(result.structuredContent.contextDirExists).toBe(false)
    // With nothing on disk, nothing is probed.
    expect(isListening).not.toHaveBeenCalled()
  })

  /**
   * THE REGRESSION. The fragment directory is found by searching UPWARD, so a cwd deep inside the repo
   * reports the same session as the repo root. Before this, `dev-status` did a plain
   * `path.join(cwd, '.infra-kit', 'dev-context')` and reported `{ active: false }` from any subdirectory,
   * while the MCP `infra-kit://dev-context` resource and the vite helper — which both search upward —
   * reported the session. One server, one question, two answers.
   */
  it('finds fragments from a NESTED cwd by searching upward (the tool/resource disagreement)', async () => {
    writeFragment('web', { package: '@acme/web', port: 5173 })

    const nested = path.join(tmpRoot, 'apps', 'client', 'src')

    fs.mkdirSync(nested, { recursive: true })

    const result = await devStatus({
      cwd: nested,
      isListening: async () => {
        return true
      },
      now: () => {
        return FRAGMENT_BASE.writtenAt
      },
    })

    expect(result.structuredContent.active).toBe(true)
    expect(
      result.structuredContent.apps.map((a) => {
        return a.app
      }),
    ).toEqual(['web'])
    expect(result.structuredContent.contextDir).toBe(devContextDir())
    expect(result.structuredContent.contextDirExists).toBe(true)
  })

  /**
   * Pins the resolver's fallback, which is easy to mistake for an edge case and is not: when no
   * `.infra-kit/dev-context` exists up-tree, the resolver DERIVES one from the nearest `.infra-kit`. The
   * returned path is then a directory nothing ever wrote to and that the read never opened — the ordinary
   * state in any repo where `infra-kit dev` has not run. `contextDir` alone would be actively misleading
   * here; `contextDirExists` is what makes it interpretable.
   */
  it('reports a DERIVED contextDir as not existing when only a bare .infra-kit anchor is up-tree', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.infra-kit'), { recursive: true })

    const nested = path.join(tmpRoot, 'apps', 'client')

    fs.mkdirSync(nested, { recursive: true })

    const isListening = vi.fn(async () => {
      return true
    })

    const result = await devStatus({ cwd: nested, isListening })

    expect(result.structuredContent.active).toBe(false)
    expect(result.structuredContent.contextDir).toBe(devContextDir())
    // Resolved, never opened — the discriminator that keeps the path from being read as evidence.
    expect(result.structuredContent.contextDirExists).toBe(false)
    expect(isListening).not.toHaveBeenCalled()
  })

  /**
   * `contextDirExists` must mean "a directory that can be listed", not "something is at this path". A
   * plain FILE at the fragment path also satisfies `existsSync`, but the reader's `readdirSync` then
   * throws ENOTDIR and swallows it into an empty result — so a bare existence check would report
   * `true` for a path that could not be read at all, and the log would assert an empty directory that
   * was never opened. That is the exact inversion this field exists to prevent.
   */
  it('reports contextDirExists FALSE when the path is a file, not a listable directory', async () => {
    fs.mkdirSync(path.join(tmpRoot, '.infra-kit'), { recursive: true })
    fs.writeFileSync(devContextDir(), 'not a directory')

    const result = await devStatus({
      cwd: tmpRoot,
      isListening: async () => {
        return true
      },
    })

    expect(result.structuredContent.active).toBe(false)
    expect(result.structuredContent.contextDir).toBe(devContextDir())
    expect(result.structuredContent.contextDirExists).toBe(false)
  })

  it('names the searched directory on BOTH the empty and the populated log paths', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {
      return undefined
    })

    fs.mkdirSync(path.join(tmpRoot, '.infra-kit'), { recursive: true })
    await devStatus({
      cwd: tmpRoot,
      isListening: async () => {
        return false
      },
    })

    expect(
      info.mock.calls.some(([line]) => {
        return typeof line === 'string' && line.includes(devContextDir())
      }),
    ).toBe(true)

    info.mockClear()
    writeFragment('web')
    await devStatus({
      cwd: tmpRoot,
      isListening: async () => {
        return true
      },
      now: () => {
        return FRAGMENT_BASE.writtenAt
      },
    })

    expect(
      info.mock.calls.some(([line]) => {
        return typeof line === 'string' && line.includes(devContextDir())
      }),
    ).toBe(true)
  })

  /**
   * Guards the clock seam across the reader swap. The shared reader stamps its OWN `Date.now()` into
   * `readAt`/`ageMs`; both are deliberately ignored so freshness stays governed by the injected clock.
   * If a future edit takes `ageMs` from the reader instead, this fails instead of going quietly wrong.
   */
  it('derives ageSeconds from the INJECTED clock, not the reader own wall-clock stamp', async () => {
    const file = writeFragment('web')
    const mtimeSec = Math.floor(Date.now() / 1000) - 120

    fs.utimesSync(file, mtimeSec, mtimeSec)

    const result = await devStatus({
      cwd: tmpRoot,
      isListening: async () => {
        return true
      },
      // 3600s after the fragment mtime — wall-clock would say ~120s.
      now: () => {
        return mtimeSec * 1000 + 3_600_000
      },
    })

    expect(result.structuredContent.apps[0]!.ageSeconds).toBe(3600)
  })

  /**
   * The invariant the whole change exists to establish: the `dev-status` TOOL and the
   * `infra-kit://dev-context` RESOURCE — both served by the same MCP server — must answer the same
   * question the same way. They now share one reader, so this is close to tautological; it is kept as a
   * tripwire, because the previous state of the world was exactly two readers that had drifted apart.
   */
  it('agrees with the MCP resource reader on directory AND app set, from the same nested cwd', async () => {
    writeFragment('web', { package: '@acme/web', port: 5173 })
    writeFragment('api', { package: '@acme/api', port: 8080 })

    const nested = path.join(tmpRoot, 'apps', 'client')

    fs.mkdirSync(nested, { recursive: true })

    const tool = await devStatus({
      cwd: nested,
      isListening: async () => {
        return false
      },
      now: () => {
        return FRAGMENT_BASE.writtenAt
      },
    })
    const resource = readDevContext(nested)

    expect(tool.structuredContent.contextDir).toBe(resource.fragmentDir)
    expect(
      tool.structuredContent.apps.map((a) => {
        return a.app
      }),
    ).toEqual(
      resource.apps.map((a) => {
        return a.app
      }),
    )
    expect(tool.structuredContent.active).toBe(resource.session === 'active')
  })

  it('surfaces freshness from the fragment file mtime (ageSeconds + ISO mtime)', async () => {
    const file = writeFragment('web')

    // Backdate the fragment file by 10 minutes.
    const tenMinAgoSec = Math.floor(Date.now() / 1000) - 600

    fs.utimesSync(file, tenMinAgoSec, tenMinAgoSec)

    const now = tenMinAgoSec * 1000 + 600_000 // exactly 600s after the mtime
    const isListening = vi.fn(async () => {
      return true
    })

    const result = await devStatus({
      cwd: tmpRoot,
      isListening,
      now: () => {
        return now
      },
    })

    const web = result.structuredContent.apps[0]!

    expect(web.ageSeconds).toBe(600)
    expect(web.fragmentMtime).toBe(new Date(tenMinAgoSec * 1000).toISOString())
  })

  it('skips a half-written / corrupt fragment instead of throwing', async () => {
    writeFragment('good')

    const dir = devContextDir()

    fs.writeFileSync(path.join(dir, 'broken.json'), '{ this is not json')
    // A .tmp file the runner leaves mid-rename must never be read.
    fs.writeFileSync(path.join(dir, 'web.json.999.tmp'), JSON.stringify(FRAGMENT_BASE))

    const isListening = vi.fn(async () => {
      return true
    })

    const result = await devStatus({
      cwd: tmpRoot,
      isListening,
      now: () => {
        return FRAGMENT_BASE.writtenAt
      },
    })

    expect(
      result.structuredContent.apps.map((a) => {
        return a.app
      }),
    ).toEqual(['good'])
  })
})
