import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { checkInfraKitConfigValid, readDoctorConfig } from '../doctor'

/**
 * The loader strips legacy `cmux` keys in memory so nothing bricks, which means the merged config
 * parses clean while a file still needs `infra-kit setup`. Doctor is the only surface that can say
 * so without a write — the row must turn yellow, not stay green, on exactly that state.
 */
const layers = vi.hoisted(() => {
  return { main: '', userGlobal: '', userProject: '' }
})

vi.mock('src/lib/infra-kit-config', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('src/lib/infra-kit-config')>()),
    resetInfraKitConfigCache: vi.fn(),
    getInfraKitConfig: vi.fn(() => {
      return Promise.resolve({})
    }),
    getInfraKitConfigPaths: vi.fn(() => {
      return Promise.resolve({ ...layers, projectName: 'repo' })
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const layerFiles = (contents: { main?: unknown; userGlobal?: unknown }): void => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-legacy-'))

  layers.main = join(dir, 'infra-kit.json')
  layers.userGlobal = join(dir, 'user-global.json')
  layers.userProject = join(dir, 'user-project.json')

  if (contents.main !== undefined) writeFileSync(layers.main, JSON.stringify(contents.main))
  if (contents.userGlobal !== undefined) writeFileSync(layers.userGlobal, JSON.stringify(contents.userGlobal))
}

describe('infra-kit config valid — legacy cmux keys', () => {
  it('reports each layer file that still carries a legacy key', async () => {
    layerFiles({
      main: { environments: ['dev'], devServersPresets: { a: { apps: {}, cmux: true } } },
      userGlobal: { worktrees: { openInCmux: true, cmux: { layout: 'two-columns' } } },
    })

    const read = await readDoctorConfig()

    expect(read.error).toBeNull()
    expect(read.legacyCmuxKeys).toEqual([
      { file: layers.main, paths: ['devServersPresets.a.cmux'] },
      { file: layers.userGlobal, paths: ['worktrees.openInCmux', 'worktrees.cmux'] },
    ])
  })

  it('turns the row yellow and names the file and the command that rewrites it', async () => {
    layerFiles({ userGlobal: { worktrees: { openInCmux: true } } })

    const check = checkInfraKitConfigValid(await readDoctorConfig())

    expect(check.status).toBe('warn')
    expect(check.message).toContain('worktrees.openInCmux')
    expect(check.message).toContain('run `infra-kit setup` to migrate them to orca')
  })

  it('stays green when no layer carries a legacy key, and skips absent or unparseable files', async () => {
    layerFiles({ main: { environments: ['dev'] } })
    writeFileSync(layers.userGlobal, '{ not json')

    const read = await readDoctorConfig()

    expect(read.legacyCmuxKeys).toEqual([])
    expect(checkInfraKitConfigValid(read).status).toBe('pass')
  })

  it('a failing merged parse still wins over the legacy-key scan', () => {
    const check = checkInfraKitConfigValid({ config: null, error: new Error('bad config'), legacyCmuxKeys: [] })

    expect(check).toMatchObject({ status: 'fail', message: 'bad config' })
  })
})
