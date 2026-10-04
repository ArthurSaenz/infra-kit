import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { syncPackageGuidance, syncRootGuidance } from 'src/lib/agent-guidance'
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import packageJson from '../../../../package.json' with { type: 'json' }
import { initCore, logInitEntry } from '../init'

// The migrations are exercised by their own suites; here they would only add temp-dir
// bookkeeping between `initCore` and the agent-guidance step under test.
vi.mock('../migrate-config', () => {
  return {
    migrateConfigShapes: vi.fn(async () => {}),
    migrateFactoryConfigToJson: vi.fn(async () => {}),
    migrateLegacyConfig: vi.fn(async () => {}),
    migrateUserGlobalConfigFilename: vi.fn(async () => {}),
  }
})

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

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const CHECK_FAILURE =
  /^1 agent-instruction files could not be checked — run: infra-kit audit --root && infra-kit audit --all$/
const DRIFT_SUMMARY = /^3 agent-instruction files differ from infra-kit .+ — setup does not rewrite them; run:$/
const CURRENT_SUMMARY = /^Agent-instruction files current \(infra-kit .+\)$/

let home: string
let repo: string

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
}

/** Every string `logger.<level>` was called with during the current test. */
const loggedAt = (level: 'info' | 'warn'): string[] => {
  return vi.mocked(logger[level]).mock.calls.map((call) => {
    return typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0])
  })
}

/** Whether any line logged at `level` matches. */
const loggedMatching = (level: 'info' | 'warn', pattern: RegExp): boolean => {
  return loggedAt(level).some((line) => {
    return pattern.test(line)
  })
}

beforeEach(() => {
  vi.clearAllMocks()

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'init-guidance-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'init-guidance-repo-'))

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(repo))

  // A two-package pnpm workspace that is also an infra-kit repo.
  writeFile(path.join(repo, 'infra-kit.json'), '{}\n')
  writeFile(path.join(repo, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
  writeFile(path.join(repo, 'packages', 'alpha', 'package.json'), '{ "name": "@test/alpha" }\n')
  writeFile(path.join(repo, 'packages', 'beta', 'package.json'), '{ "name": "@test/beta" }\n')

  // The layer-3 reseed needs a real git repo we deliberately do not have here.
  process.env.INFRA_KIT_NO_SEED = '1'

  // The config cache keys on values these tests change between cases (the mocked project
  // root), so a carried-over entry would answer for the previous test's already-deleted
  // directory.
  resetInfraKitConfigCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  delete process.env.INFRA_KIT_NO_SEED
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
  // initCore now scaffolds <mainRepoRoot>-worktrees beside the repo (US-002); it is a sibling
  // of `repo`, not inside it, so it needs its own cleanup.
  fs.rmSync(`${repo}-worktrees`, { recursive: true, force: true })
})

/**
 * The additive half on its own: `initCore` with the CLI's entry logger, which is exactly what
 * `infra-kit setup --skip-tools` runs (setup wraps the same sink only to hold its closing
 * shell-activation line back until after the dependency half). The standalone `init` command this
 * suite used to drive no longer exists, so the pairing IS the subject now.
 */
const runInit = async (): Promise<void> => {
  await initCore(logInitEntry)
}

/** What `audit --fix --root` and `audit --fix --all` leave behind: every block current. */
const writeCurrentGuidance = async (): Promise<void> => {
  const { version } = packageJson

  await syncRootGuidance(repo, { version })

  for (const name of ['alpha', 'beta']) {
    await syncPackageGuidance(path.join(repo, 'packages', name), { repoRoot: repo, version })
  }
}

describe('setup --skip-tools — repo-wide agent-guidance check', () => {
  it('writes no guidance file, and names both refresh commands when root and packages drifted', async () => {
    await runInit()

    for (const rel of ['CLAUDE.md', 'packages/alpha/CLAUDE.md', 'packages/beta/CLAUDE.md']) {
      expect(fs.existsSync(path.join(repo, rel))).toBe(false)
    }

    expect(loggedMatching('info', DRIFT_SUMMARY)).toBe(true)
    expect(loggedAt('info')).toContain('infra-kit audit --fix --root')
    expect(loggedAt('info')).toContain('infra-kit audit --fix --all')
  })

  it('names only the package command when the root block is current', async () => {
    await syncRootGuidance(repo, { version: packageJson.version })
    const rootBefore = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8')

    await runInit()

    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8')).toBe(rootBefore)
    expect(loggedAt('info')).not.toContain('infra-kit audit --fix --root')
    expect(loggedAt('info')).toContain('infra-kit audit --fix --all')
  })

  it('reports current, with no command, when every block matches this CLI', async () => {
    await writeCurrentGuidance()

    const before = ['CLAUDE.md', 'packages/alpha/CLAUDE.md', 'packages/beta/CLAUDE.md'].map((rel) => {
      return fs.readFileSync(path.join(repo, rel), 'utf-8')
    })

    await runInit()

    const after = ['CLAUDE.md', 'packages/alpha/CLAUDE.md', 'packages/beta/CLAUDE.md'].map((rel) => {
      return fs.readFileSync(path.join(repo, rel), 'utf-8')
    })

    expect(after).toEqual(before)
    expect(loggedMatching('info', CURRENT_SUMMARY)).toBe(true)
    expect(
      loggedAt('info').filter((line) => {
        return line.startsWith('infra-kit audit --fix')
      }),
    ).toEqual([])
  })

  it('reports an uncheckable file as a warning, keeps going, and leaves the exit code untouched', async () => {
    await writeCurrentGuidance()
    fs.rmSync(path.join(repo, 'packages', 'alpha', 'CLAUDE.md'))
    // A dangling symlink: `existsSync` follows links and reports false, so only the
    // `lstat` guard catches it — the failure path under test.
    fs.symlinkSync(
      path.join(repo, 'packages', 'alpha', 'nowhere.md'),
      path.join(repo, 'packages', 'alpha', 'CLAUDE.md'),
    )

    await runInit()

    expect(loggedMatching('warn', CHECK_FAILURE)).toBe(true)
    expect(process.exitCode ?? 0).toBe(0)
    expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(true)
  })

  it('skips the whole check outside an infra-kit repo, without failing init', async () => {
    fs.rmSync(path.join(repo, 'infra-kit.json'))
    resetInfraKitConfigCache()

    await runInit()

    expect(fs.existsSync(path.join(repo, 'CLAUDE.md'))).toBe(false)
    expect(loggedMatching('info', CURRENT_SUMMARY)).toBe(false)
    expect(loggedMatching('info', DRIFT_SUMMARY)).toBe(false)
    expect(process.exitCode ?? 0).toBe(0)
  })
})
