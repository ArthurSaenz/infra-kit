import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    // With nothing on disk, nothing is probed.
    expect(isListening).not.toHaveBeenCalled()
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
