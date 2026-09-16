import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Import AFTER the mock is declared so the module picks up the mocked dep.
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'

import { migrateCmuxConfigToOrca } from '../migrate-config'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    // Mirror the real signature: with a linked-worktree-free test repo the main
    // root IS the given toplevel, so echo the passed cwd back.
    getMainRepoRoot: vi.fn(async (cwd?: string) => {
      return cwd
    }),
  }
})

const ENV = '"envManagement": {"provider": "doppler", "config": {"name": "p"}}'

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
}

const withTmpHome = async (
  fn: (tmp: string) => Promise<void>,
  { insideProject }: { insideProject: boolean },
): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-migrate-cmux-test-'))

  if (insideProject) {
    vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  } else {
    vi.mocked(getProjectRoot).mockRejectedValue(new Error('fatal: not a git repository'))
  }

  vi.mocked(getRepoName).mockResolvedValue(path.basename(tmp))
  const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp)

  resetInfraKitConfigCache()

  try {
    await fn(tmp)
  } finally {
    homedirSpy.mockRestore()
    resetInfraKitConfigCache()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

describe('migrateCmuxConfigToOrca', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('rewrites openInCmux → openInOrca in the project layer and leaves everything else in place', async () => {
    await withTmpHome(
      async (tmp) => {
        const jsonPath = path.join(tmp, 'infra-kit.json')

        writeFile(
          jsonPath,
          `{\n  ${ENV},\n  "worktrees": {\n    "openInGithubDesktop": false,\n    "openInCmux": true\n  }\n}\n`,
        )

        await migrateCmuxConfigToOrca()

        // Same 2-space / trailing-newline shape the other migrations write, keys in their original order.
        expect(fs.readFileSync(jsonPath, 'utf-8')).toBe(
          `{\n  "envManagement": {\n    "provider": "doppler",\n    "config": {\n      "name": "p"\n    }\n  },\n  "worktrees": {\n    "openInGithubDesktop": false,\n    "openInOrca": true\n  }\n}\n`,
        )
      },
      { insideProject: true },
    )
  })

  it('migrates all three key paths across the project, user-global and user-project layers in one run', async () => {
    await withTmpHome(
      async (tmp) => {
        const main = path.join(tmp, 'infra-kit.json')
        const userGlobal = path.join(tmp, '.infra-kit', 'infra-kit.json')
        const userProject = path.join(tmp, '.infra-kit', 'projects', path.basename(tmp), 'infra-kit.json')

        writeFile(main, `{${ENV}, "devServersPresets": {"backend": {"apps": {}, "cmux": true}}}`)
        writeFile(userGlobal, '{"worktrees": {"openInCmux": true, "cmux": {"layout": "three-pane"}}}')
        writeFile(userProject, '{"worktrees": {"cmux": {"layout": "two-columns"}}}')

        await migrateCmuxConfigToOrca()

        expect(JSON.parse(fs.readFileSync(main, 'utf-8'))).toEqual({
          envManagement: { provider: 'doppler', config: { name: 'p' } },
          devServersPresets: { backend: { apps: {}, orca: true } },
        })
        expect(JSON.parse(fs.readFileSync(userGlobal, 'utf-8'))).toEqual({
          worktrees: { openInOrca: true, orca: { layout: 'three-pane' } },
        })
        expect(JSON.parse(fs.readFileSync(userProject, 'utf-8'))).toEqual({
          worktrees: { orca: { layout: 'two-columns' } },
        })
      },
      { insideProject: true },
    )
  })

  it('leaves a config without legacy keys byte-for-byte and mtime untouched (idempotent no-op)', async () => {
    await withTmpHome(
      async (tmp) => {
        const jsonPath = path.join(tmp, 'infra-kit.json')
        // Deliberately NOT the 2-space shape: a rewrite would normalise it, so byte identity proves no write.
        const json = `{${ENV},"worktrees":{"openInOrca":true,"orca":{"layout":"three-pane"}}}`

        writeFile(jsonPath, json)
        const before = fs.statSync(jsonPath).mtimeMs

        await migrateCmuxConfigToOrca()

        expect(fs.readFileSync(jsonPath, 'utf-8')).toBe(json)
        expect(fs.statSync(jsonPath).mtimeMs).toBe(before)
      },
      { insideProject: true },
    )
  })

  it('is idempotent — a second run after a migration writes nothing', async () => {
    await withTmpHome(
      async (tmp) => {
        const jsonPath = path.join(tmp, 'infra-kit.json')

        writeFile(jsonPath, `{${ENV},"worktrees":{"openInCmux":true}}`)

        await migrateCmuxConfigToOrca()
        const migrated = fs.readFileSync(jsonPath, 'utf-8')
        const mtime = fs.statSync(jsonPath).mtimeMs

        await migrateCmuxConfigToOrca()

        expect(fs.readFileSync(jsonPath, 'utf-8')).toBe(migrated)
        expect(fs.statSync(jsonPath).mtimeMs).toBe(mtime)
      },
      { insideProject: true },
    )
  })

  it('outside a project, still migrates the user-global file (the layer most likely to carry the key)', async () => {
    await withTmpHome(
      async (tmp) => {
        const userGlobal = path.join(tmp, '.infra-kit', 'infra-kit.json')
        // A stray project-shaped file at $HOME must NOT be touched: there is no project here.
        const strayMain = path.join(tmp, 'infra-kit.json')
        const stray = `{${ENV},"worktrees":{"openInCmux":true}}`

        writeFile(userGlobal, '{"worktrees": {"openInCmux": true}}')
        writeFile(strayMain, stray)

        await migrateCmuxConfigToOrca()

        expect(JSON.parse(fs.readFileSync(userGlobal, 'utf-8'))).toEqual({ worktrees: { openInOrca: true } })
        expect(fs.readFileSync(strayMain, 'utf-8')).toBe(stray)
      },
      { insideProject: false },
    )
  })

  it('outside a project with no user-global file is a silent no-op', async () => {
    await withTmpHome(
      async () => {
        await expect(migrateCmuxConfigToOrca()).resolves.toBeUndefined()
      },
      { insideProject: false },
    )
  })

  it('warns and skips malformed JSON without throwing', async () => {
    await withTmpHome(
      async (tmp) => {
        const jsonPath = path.join(tmp, 'infra-kit.json')

        writeFile(jsonPath, '{ not valid json ')

        await expect(migrateCmuxConfigToOrca()).resolves.toBeUndefined()

        expect(fs.readFileSync(jsonPath, 'utf-8')).toBe('{ not valid json ')
      },
      { insideProject: true },
    )
  })
})
