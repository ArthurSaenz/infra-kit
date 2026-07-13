import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildUserProjectExample } from 'src/lib/config-templates'
// Imported AFTER the mock factory below is hoisted, so the module under test sees the fakes.
import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig, getInfraKitConfigPaths, resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import { ensureUserProjectConfig, resetUserProjectSeedGuard, seedUserProjectConfig } from '../config-bootstrap'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    getMainRepoRoot: vi.fn(),
  }
})

let home: string
let repo: string
let repoName: string
let userProjectDir: string
let configPath: string
let examplePath: string
let infoSpy: ReturnType<typeof vi.spyOn>
let debugSpy: ReturnType<typeof vi.spyOn>

const writeMainConfig = (): void => {
  fs.writeFileSync(path.join(repo, 'infra-kit.json'), '{}\n')
}

const preSeed = (configContent: string, exampleContent: string): void => {
  fs.mkdirSync(userProjectDir, { recursive: true })
  fs.writeFileSync(configPath, configContent)
  fs.writeFileSync(examplePath, exampleContent)
}

beforeEach(() => {
  // `vitest.setup.ts` arms INFRA_KIT_NO_SEED=1 globally so no test can ever write to the real $HOME.
  // Disarm it HERE (empty string — the guard is a truthiness check) or every negative case below
  // would pass vacuously. Safe: os.homedir() is stubbed to a throwaway mkdtemp for this file.
  vi.stubEnv('INFRA_KIT_NO_SEED', '')
  // The git-utils fakes come from the hoisted `vi.mock` factory, so `restoreAllMocks()` does not
  // reset their call history — clear it here or the once-per-process assertion counts every test.
  vi.clearAllMocks()

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'config-bootstrap-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'config-bootstrap-repo-'))
  repoName = path.basename(repo)
  userProjectDir = path.join(home, '.infra-kit', 'projects', repoName)
  configPath = path.join(userProjectDir, 'infra-kit.json')
  examplePath = path.join(userProjectDir, 'infra-kit.example.jsonc')

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
  debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})

  resetUserProjectSeedGuard()
  resetInfraKitConfigCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetUserProjectSeedGuard()
  resetInfraKitConfigCache()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('ensureUserProjectConfig', () => {
  it('seeds the empty layer-3 config plus its annotated example on the first run, logging exactly once', async () => {
    writeMainConfig()

    await ensureUserProjectConfig()

    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{}\n')
    expect(fs.readFileSync(examplePath, 'utf-8')).toBe(buildUserProjectExample(repoName))
    expect(infoSpy).toHaveBeenCalledTimes(1)
  })

  it('performs zero writes and stays silent on the second run', async () => {
    writeMainConfig()

    await ensureUserProjectConfig()

    const configBytes = fs.readFileSync(configPath, 'utf-8')
    const exampleBytes = fs.readFileSync(examplePath, 'utf-8')

    resetUserProjectSeedGuard()
    infoSpy.mockClear()

    const writeSpy = vi.spyOn(fsp, 'writeFile')

    await ensureUserProjectConfig()

    expect(writeSpy).toHaveBeenCalledTimes(0)
    expect(infoSpy).toHaveBeenCalledTimes(0)
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(configBytes)
    expect(fs.readFileSync(examplePath, 'utf-8')).toBe(exampleBytes)
  })

  it('rewrites a stale example exactly once and never touches the existing config', async () => {
    writeMainConfig()
    preSeed('{}\n', '// stale\n')

    const writeSpy = vi.spyOn(fsp, 'writeFile')

    await ensureUserProjectConfig()

    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy.mock.calls[0]?.[0]).toBe(examplePath)
    expect(fs.readFileSync(examplePath, 'utf-8')).toBe(buildUserProjectExample(repoName))
  })

  it('performs zero writes when the example is already identical to the template', async () => {
    writeMainConfig()
    preSeed('{}\n', buildUserProjectExample(repoName))

    const writeSpy = vi.spyOn(fsp, 'writeFile')

    await ensureUserProjectConfig()

    expect(writeSpy).toHaveBeenCalledTimes(0)
  })

  it('leaves a real user layer-3 config byte-unchanged and reports createdConfig=false', async () => {
    writeMainConfig()

    const realConfig = '{"ide":{"provider":"cursor","config":{"workspaceConfigPath":"./ws.code-workspace"}}}\n'

    preSeed(realConfig, buildUserProjectExample(repoName))

    await ensureUserProjectConfig()

    expect(fs.readFileSync(configPath, 'utf-8')).toBe(realConfig)

    const result = await seedUserProjectConfig(await getInfraKitConfigPaths())

    expect(result.createdConfig).toBe(false)
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(realConfig)
  })

  it('creates nothing when the git repo has no committed infra-kit.json (D2 gate)', async () => {
    await expect(ensureUserProjectConfig()).resolves.toBeUndefined()

    expect(fs.existsSync(path.join(home, '.infra-kit', 'projects'))).toBe(false)
  })

  it('resolves without writing anything outside a git repo', async () => {
    vi.mocked(getProjectRoot).mockRejectedValue(new Error('not a git repository'))

    const writeSpy = vi.spyOn(fsp, 'writeFile')

    await expect(ensureUserProjectConfig()).resolves.toBeUndefined()

    expect(writeSpy).toHaveBeenCalledTimes(0)
    expect(fs.existsSync(path.join(home, '.infra-kit'))).toBe(false)
  })

  it('keys the override dir on the MAIN repo root, not the worktree leaf', async () => {
    writeMainConfig()
    // `repo` plays the linked worktree here; only the basename of the main repo root is used, so the
    // main root never has to exist on disk.
    vi.mocked(getMainRepoRoot).mockResolvedValue('/repos/hulyo-monorepo')

    await ensureUserProjectConfig()

    const projectsDir = path.join(home, '.infra-kit', 'projects')

    expect(fs.existsSync(path.join(projectsDir, 'hulyo-monorepo', 'infra-kit.json'))).toBe(true)
    expect(fs.existsSync(path.join(projectsDir, repoName))).toBe(false)
  })

  it('swallows a read-only HOME (injected EACCES), keeping the exit code untouched', async () => {
    writeMainConfig()

    const exitCodeBefore = process.exitCode

    vi.spyOn(fsp, 'mkdir').mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))

    await expect(ensureUserProjectConfig()).resolves.toBeUndefined()

    expect(debugSpy).toHaveBeenCalled()
    expect(infoSpy).toHaveBeenCalledTimes(0)
    expect(process.exitCode).toBe(exitCodeBefore)
  })

  it('resolves the paths only once per process (long-lived MCP server)', async () => {
    writeMainConfig()

    await ensureUserProjectConfig()
    await ensureUserProjectConfig()

    expect(vi.mocked(getProjectRoot)).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when INFRA_KIT_NO_SEED is set (the kill switch)', async () => {
    vi.stubEnv('INFRA_KIT_NO_SEED', '1')
    writeMainConfig()

    const writeSpy = vi.spyOn(fsp, 'writeFile')

    await ensureUserProjectConfig()

    expect(writeSpy).toHaveBeenCalledTimes(0)
    expect(fs.existsSync(path.join(home, '.infra-kit'))).toBe(false)
  })
})

describe('seedUserProjectConfig', () => {
  it('is ungated — it still seeds in a repo with no committed infra-kit.json (so `config edit` works)', async () => {
    const paths = await getInfraKitConfigPaths()

    const result = await seedUserProjectConfig(paths)

    expect(result.createdConfig).toBe(true)
    expect(result.refreshedExample).toBe(true)
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{}\n')
    expect(fs.readFileSync(examplePath, 'utf-8')).toBe(buildUserProjectExample(repoName))
  })

  it('keeps the path memo alive across the seed — creating layer 3 costs no extra git spawns', async () => {
    // A schema-valid layer 1, so `getInfraKitConfig()` below has something to merge.
    fs.writeFileSync(
      path.join(repo, 'infra-kit.json'),
      JSON.stringify({
        environments: ['dev'],
        envManagement: { provider: 'doppler', config: { name: 'seed-test' } },
      }),
    )

    const paths = await getInfraKitConfigPaths()

    // Prime BOTH caches while layer 3 is still absent.
    await getInfraKitConfig()

    vi.mocked(getProjectRoot).mockClear()
    vi.mocked(getMainRepoRoot).mockClear()

    const result = await seedUserProjectConfig(paths)

    expect(result.createdConfig).toBe(true)

    await getInfraKitConfigPaths()

    // The memo keys on `cwd + homedir`; WRITING A FILE changes neither. Seeding must therefore drop
    // the merged cache ONLY — a full `resetInfraKitConfigCache()` here would make the one run that
    // creates the file re-spawn both `git rev-parse` calls (4 spawns instead of 2).
    expect(vi.mocked(getProjectRoot)).toHaveBeenCalledTimes(0)
    expect(vi.mocked(getMainRepoRoot)).toHaveBeenCalledTimes(0)

    // …and the merged config is NOT served stale: layer 3 is a real merge layer, so what now lives in
    // the freshly created file wins over layer 1.
    fs.writeFileSync(configPath, JSON.stringify({ environments: ['prod'] }))

    await expect(getInfraKitConfig()).resolves.toMatchObject({ environments: ['prod'] })
  })
})
