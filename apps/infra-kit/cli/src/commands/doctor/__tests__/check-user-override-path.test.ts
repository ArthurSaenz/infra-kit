import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkUserOverridePath } from '../doctor'

const cfg = vi.hoisted(() => {
  return { userProject: '', shouldThrow: false }
})

vi.mock('src/lib/infra-kit-config', () => {
  return {
    getInfraKitConfig: vi.fn(),
    resetInfraKitConfigCache: vi.fn(),
    resolveConfiguredIdes: vi.fn(() => {
      return []
    }),
    getInfraKitConfigPaths: vi.fn(() => {
      if (cfg.shouldThrow) {
        return Promise.reject(new Error('not a git repository'))
      }

      return Promise.resolve({
        main: '',
        userGlobal: '',
        userProject: cfg.userProject,
        projectName: 'api',
      })
    }),
  }
})

// Never spawn git from a unit test — and never let a real repo lookup steer the paths.
vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    getMainRepoRoot: vi.fn(),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

let home: string
let projectDir: string

beforeEach(() => {
  vi.clearAllMocks()

  // Load-bearing: `tildify` reads os.homedir(), and no test may ever touch the developer's real
  // $HOME. Nothing here writes outside this temp dir.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-user-override-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)

  projectDir = path.join(home, '.infra-kit', 'projects', 'api')
  fs.mkdirSync(projectDir, { recursive: true })

  cfg.shouldThrow = false
  cfg.userProject = path.join(projectDir, 'infra-kit.json')
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('checkUserOverridePath', () => {
  it('flags an ABSENT file as a possible seed failure (every command seeds layer 3 now)', async () => {
    const result = await checkUserOverridePath()

    expect(result.status).toBe('pass')
    expect(result.message).toContain('(not created — seed failed?)')
    expect(result.message).toContain('~/.infra-kit/projects/api/infra-kit.json')
    expect(result.message).toContain('project: api')
  })

  it('reports a healthy just-seeded empty file as carrying no overrides', async () => {
    fs.writeFileSync(cfg.userProject, '{}\n')

    const result = await checkUserOverridePath()

    expect(result.status).toBe('pass')
    expect(result.message).toContain('(empty — no overrides)')
    // The whole point of the 3-way split: an empty file must NOT read like a failed seed.
    expect(result.message).not.toContain('seed failed')
  })

  it('lists the raw top-level keys when the file carries real overrides', async () => {
    fs.writeFileSync(cfg.userProject, JSON.stringify({ ide: { name: 'zed' }, dev: { api: { port: 3000 } } }))

    const result = await checkUserOverridePath()

    expect(result.status).toBe('pass')
    expect(result.message).toContain('(2 override(s): ide, dev)')
  })

  it('degrades to an unreadable line instead of throwing on malformed JSON', async () => {
    fs.writeFileSync(cfg.userProject, '{ not json')

    const result = await checkUserOverridePath()

    expect(result.status).toBe('pass')
    expect(result.message).toContain('(unreadable — invalid JSON)')
  })

  it('fails when the config paths cannot be resolved (outside a git repo)', async () => {
    cfg.shouldThrow = true

    const result = await checkUserOverridePath()

    expect(result.status).toBe('fail')
    expect(result.message).toBe('not a git repository')
  })
})
