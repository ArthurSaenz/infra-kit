import { describe, expect, it, vi } from 'vitest'

import { probeAll, probeDependency } from 'src/lib/dependency-probe'
import type { ProbeDeps, ProbeRunResult } from 'src/lib/dependency-probe'
import { specFor } from 'src/lib/dependency-registry'

/** A `ProbeDeps` where every seam fails/misses by default — each test overrides only what it needs. */
const emptyDeps = (overrides: Partial<ProbeDeps> = {}): ProbeDeps => {
  return {
    runCommand: vi.fn().mockRejectedValue(new Error('ENOENT')),
    resolveBinPath: vi.fn().mockResolvedValue(null),
    realpath: (p) => {
      return p
    },
    platform: 'darwin',
    ...overrides,
  }
}

const ok = (stdout: string): Promise<ProbeRunResult> => {
  return Promise.resolve({ stdout })
}

describe('probeDependency: present vs onPath', () => {
  it('is present and NOT onPath when resolveBinPath finds the binary but the PATH run fails', async () => {
    const deps = emptyDeps({
      runCommand: vi.fn().mockRejectedValue(new Error('command not found')),
      resolveBinPath: vi.fn().mockResolvedValue('/Users/x/.local/bin/aws'),
    })

    const state = await probeDependency(specFor('aws'), deps)

    expect(state.present).toBe(true)
    expect(state.onPath).toBe(false)
    expect(state.binRealPath).toBe('/Users/x/.local/bin/aws')
  })

  it('is present and onPath when the PATH run succeeds', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: 'gh version 2.40.0 (2023-12-05)\nhttps://x' })
    const deps = emptyDeps({
      runCommand,
      resolveBinPath: vi.fn().mockResolvedValue('/opt/homebrew/Cellar/gh/2.40.0/bin/gh'),
    })

    const state = await probeDependency(specFor('gh'), deps)

    expect(state.present).toBe(true)
    expect(state.onPath).toBe(true)
    // The PATH run's own stdout is what supplies the version — no second `runCommand` call is needed.
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it('is neither present nor onPath when both seams miss', async () => {
    const state = await probeDependency(specFor('doppler'), emptyDeps())

    expect(state).toEqual({
      id: 'doppler',
      present: false,
      onPath: false,
      binRealPath: null,
      version: null,
      manager: 'unknown',
    })
  })
})

describe('manager attribution goes through spec.identify — the PM-2 split-brain cases', () => {
  it('resolves the aws script layout to "script", never "homebrew"', async () => {
    const deps = emptyDeps({
      resolveBinPath: vi.fn().mockResolvedValue('/Users/x/.local/share/aws-cli/v2/2.17.0/dist/aws'),
    })

    const state = await probeDependency(specFor('aws'), deps)

    expect(state.manager).toBe('script')
  })

  it('resolves a real brew keg to "homebrew"', async () => {
    const deps = emptyDeps({
      resolveBinPath: vi.fn().mockResolvedValue('/opt/homebrew/Cellar/gh/2.40.0/bin/gh'),
    })

    const state = await probeDependency(specFor('gh'), deps)

    expect(state.manager).toBe('homebrew')
  })

  it('resolves gh sitting inside a NODE keg (not its own) to "unknown"', async () => {
    const deps = emptyDeps({
      resolveBinPath: vi.fn().mockResolvedValue('/opt/homebrew/Cellar/node/24.0.0/lib/node_modules/gh/bin/gh'),
    })

    const state = await probeDependency(specFor('gh'), deps)

    expect(state.manager).toBe('unknown')
  })
})

describe('version parsing from real --version output shapes', () => {
  it('parses aws-cli’s multi-token banner', async () => {
    const deps = emptyDeps({
      runCommand: vi.fn().mockReturnValue(ok('aws-cli/2.17.0 Python/3.11.6 Darwin/23.6.0 source/arm64')),
      resolveBinPath: vi.fn().mockResolvedValue('/opt/homebrew/bin/aws'),
    })

    const state = await probeDependency(specFor('aws'), deps)

    expect(state.version).toBe('2.17.0')
  })

  it('parses doppler’s v-prefixed version', async () => {
    const deps = emptyDeps({
      runCommand: vi.fn().mockReturnValue(ok('v3.63.0')),
      resolveBinPath: vi.fn().mockResolvedValue('/opt/homebrew/Cellar/doppler/3.63.0/bin/doppler'),
    })

    const state = await probeDependency(specFor('doppler'), deps)

    expect(state.version).toBe('3.63.0')
  })

  it('parses a version off the second, absolute-path run when present && !onPath', async () => {
    const runCommand = vi.fn().mockRejectedValueOnce(new Error('not on PATH')).mockReturnValueOnce(ok('v3.63.0'))
    const deps = emptyDeps({
      runCommand,
      resolveBinPath: vi.fn().mockResolvedValue('/Users/x/.local/bin/doppler'),
    })

    const state = await probeDependency(specFor('doppler'), deps)

    expect(state.onPath).toBe(false)
    expect(state.version).toBe('3.63.0')
    expect(runCommand).toHaveBeenNthCalledWith(2, ['/Users/x/.local/bin/doppler', '--version'])
  })
})

describe('non-zero exit / missing-binary behaviour never throws', () => {
  it('reports present:false for a command that rejects, on every seam', async () => {
    await expect(probeDependency(specFor('brew'), emptyDeps())).resolves.toEqual({
      id: 'brew',
      present: false,
      onPath: false,
      binRealPath: null,
      version: null,
      manager: 'unknown',
    })
  })

  it('never throws even when resolveBinPath and realpath themselves throw', async () => {
    const deps = emptyDeps({
      resolveBinPath: vi.fn().mockResolvedValue('/some/path'),
      realpath: () => {
        throw new Error('EPERM')
      },
    })

    await expect(probeDependency(specFor('gh'), deps)).resolves.toMatchObject({ present: false, manager: 'unknown' })
  })
})

describe('platform gating', () => {
  it('does not probe a tool unsupported on the current platform', async () => {
    const runCommand = vi.fn()
    const resolveBinPath = vi.fn()
    const deps = emptyDeps({ runCommand, resolveBinPath, platform: 'win32' })

    // brew's platforms are darwin/linux only.
    const state = await probeDependency(specFor('brew'), deps)

    expect(state.present).toBe(false)
    expect(runCommand).not.toHaveBeenCalled()
    expect(resolveBinPath).not.toHaveBeenCalled()
  })

  it('does probe portless on win32, which it supports', async () => {
    const deps = emptyDeps({
      runCommand: vi.fn().mockReturnValue(ok('1.2.3')),
      platform: 'win32',
    })

    const state = await probeDependency(specFor('portless'), deps)

    expect(state.present).toBe(true)
  })
})

describe('probeAll', () => {
  it('probes every id independently and preserves order', async () => {
    const deps = emptyDeps({
      runCommand: vi.fn().mockReturnValue(ok('brew 4.3.0')),
      resolveBinPath: vi.fn().mockResolvedValue('/opt/homebrew/bin/brew'),
    })

    const states = await probeAll(['gh', 'brew', 'doppler'], deps)

    expect(
      states.map((s) => {
        return s.id
      }),
    ).toEqual(['gh', 'brew', 'doppler'])
    expect(
      states.every((s) => {
        return s.present
      }),
    ).toBe(true)
  })
})
