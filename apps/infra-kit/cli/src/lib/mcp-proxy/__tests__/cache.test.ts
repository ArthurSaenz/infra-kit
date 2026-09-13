import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { binaryFingerprint, profilePath, proxyCacheDir, readBinaryVersion, readProfile, writeProfile } from '../cache'
import type { UpstreamProfile } from '../cache'

let dir = ''

const profile = (version: string): UpstreamProfile => {
  return {
    version,
    protocolVersion: '2025-06-18',
    capabilities: { tools: { listChanged: true } },
    tools: [{ name: 'search_dashboards' }],
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-grafana-cache-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('proxyCacheDir', () => {
  it('lives under the cache root, one subdir per configured name, not the ~/.infra-kit config registry', () => {
    vi.stubEnv('XDG_CACHE_HOME', dir)

    expect(proxyCacheDir('grafana')).toBe(path.join(dir, 'infra-kit', 'mcp-proxy', 'grafana'))
    expect(proxyCacheDir('grafana')).not.toContain('.infra-kit/projects')
    expect(proxyCacheDir('grafana')).not.toBe(proxyCacheDir('github'))
  })
})

describe('version keying (D8)', () => {
  it('round-trips a profile for its own version', () => {
    expect(writeProfile(profile('v1.3.0'), dir)).toBe(true)
    expect(readProfile('v1.3.0', dir)?.tools).toEqual([{ name: 'search_dashboards' }])
  })

  it('does not serve a profile written by a different binary version', () => {
    writeProfile(profile('v1.3.0'), dir)

    expect(readProfile('v1.4.0', dir), 'an upgrade must not be served the old tool list').toBeNull()
  })

  it('writes with 0600 so a cached capability payload is not world-readable', () => {
    writeProfile(profile('v1.3.0'), dir)

    expect(fs.statSync(profilePath('v1.3.0', dir)).mode & 0o777).toBe(0o600)
  })

  it('leaves no temp file behind — the write is atomic', () => {
    writeProfile(profile('v1.3.0'), dir)

    expect(
      fs.readdirSync(dir).filter((name) => {
        return name.includes('.tmp.')
      }),
    ).toEqual([])
  })
})

describe('torn and missing caches degrade to null, never a throw', () => {
  it.each([
    ['absent', null],
    ['truncated json', '{"version":"v1.3.0","tools":[{"na'],
    ['empty', ''],
    ['valid json of the wrong shape', '{"version":"v1.3.0"}'],
  ])('%s', (_label, contents) => {
    if (contents !== null) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(profilePath('v1.3.0', dir), contents)
    }

    expect(() => {
      return readProfile('v1.3.0', dir)
    }).not.toThrow()
    expect(readProfile('v1.3.0', dir)).toBeNull()
  })
})

describe('readBinaryVersion', () => {
  it('reads the first line of --version output', () => {
    const script = path.join(dir, 'fake-bin.mjs')

    fs.writeFileSync(script, "process.stdout.write('v9.9.9\\nextra\\n')\n")

    expect(readBinaryVersion(process.execPath, [script])).toBe('v9.9.9')
  })

  it('finds a binary that is only on the supplied PATH (the go install layout)', () => {
    const binDir = path.join(dir, 'gobin')

    fs.mkdirSync(binDir, { recursive: true })
    const name = 'mcp-grafana-probe-fixture'

    fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\necho v7.7.7\n', { mode: 0o755 })

    // Without the PATH the upstream spawn uses, a GOBIN-only binary probes as ENOENT,
    // every version collapses into one 'unknown' bucket, and an upgrade is served the
    // previous tool list.
    expect(readBinaryVersion(name, ['--version'], binDir)).toBe('v7.7.7')
    expect(readBinaryVersion(name)).toBe('unknown')
  })

  it('returns "unknown" rather than throwing when the binary is absent', () => {
    expect(readBinaryVersion(path.join(dir, 'definitely-not-here'))).toBe('unknown')
  })

  it('falls back to a stat fingerprint on a non-zero exit — a binary without --version still gets a version-shaped key', () => {
    const script = path.join(dir, 'fail-bin.mjs')

    fs.writeFileSync(script, "process.stdout.write('v1.0.0\\n'); process.exit(3)\n")

    // `node <script>` fails, so the key must come from the RESOLVED binary (node itself), and it
    // must change when that binary changes — size+mtime do, a constant 'unknown' would not.
    const key = readBinaryVersion(process.execPath, [script])

    expect(key).toMatch(/^stat-\d+-\d+$/)
    expect(key).toBe(binaryFingerprint(process.execPath))
  })

  it('resolves a bare binary name through the supplied PATH for the fingerprint too', () => {
    const binDir = path.join(dir, 'bin')

    fs.mkdirSync(binDir)
    fs.writeFileSync(path.join(binDir, 'silent-tool'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    expect(binaryFingerprint('silent-tool', binDir)).toMatch(/^stat-/)
    expect(binaryFingerprint('silent-tool', path.join(dir, 'empty'))).toBe('unknown')
  })
})
