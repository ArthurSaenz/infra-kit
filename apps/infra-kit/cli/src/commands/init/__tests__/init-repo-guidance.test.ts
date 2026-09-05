import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PACKAGE_MARKER_START, resetGitStateCache } from 'src/lib/agent-guidance'
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import { AGENTS_MARKER_START } from '../agent-files'
import { init } from '../init'

// The migrations are exercised by their own suites; here they would only add temp-dir
// bookkeeping between `init()` and the agent-guidance step under test.
vi.mock('../migrate-config', () => {
  return {
    migrateFactoryConfigToJson: vi.fn(async () => {}),
    migrateLegacyConfig: vi.fn(async () => {}),
    migrateUserGlobalConfigFilename: vi.fn(async () => {}),
    normalizeLegacyIdeStructures: vi.fn(async () => {}),
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

const FAILURE_SUMMARY = '1 package guidance files could not be written — run: infra-kit audit --fix --all'

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

/** The `  <action> <relPath>` line `init` logged for `relPath`, or undefined when it logged none. */
const lineFor = (relPath: string): string | undefined => {
  return loggedAt('info').find((line) => {
    return line.includes(` ${relPath}`)
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

  // Both caches key on values these tests change between cases (the mocked project root,
  // and a fresh temp tree git has never seen), so a carried-over entry would answer for
  // the previous test's already-deleted directory.
  resetInfraKitConfigCache()
  resetGitStateCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  resetGitStateCache()
  delete process.env.INFRA_KIT_NO_SEED
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('init() — repo-wide agent-guidance refresh', () => {
  it('writes the root block and one block per workspace package, reporting each action', async () => {
    await init()

    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8')).toContain(AGENTS_MARKER_START)

    for (const name of ['alpha', 'beta']) {
      const claude = fs.readFileSync(path.join(repo, 'packages', name, 'CLAUDE.md'), 'utf-8')

      expect(claude).toContain(PACKAGE_MARKER_START)
    }

    expect(lineFor('CLAUDE.md')).toMatch(/^ {2}created {3}CLAUDE\.md$/)
    // Package lines carry the resolved package type in parentheses.
    expect(lineFor(path.join('packages', 'alpha', 'CLAUDE.md'))).toMatch(
      /^ {2}created {3}packages\/alpha\/CLAUDE\.md \(.+\)$/,
    )
    expect(lineFor(path.join('packages', 'beta', 'CLAUDE.md'))).toMatch(
      /^ {2}created {3}packages\/beta\/CLAUDE\.md \(.+\)$/,
    )

    expect(
      loggedAt('info').some((line) => {
        return /^Agent-instruction files synced \(infra-kit .+\)$/.test(line)
      }),
    ).toBe(true)

    // Nothing failed, so the summary line must not appear.
    expect(loggedAt('warn')).not.toContain(FAILURE_SUMMARY)
  })

  it('reports a per-package write failure, keeps going, and leaves the exit code untouched', async () => {
    // A dangling symlink: `existsSync` follows links and reports false, so only the
    // `lstat` guard inside the writer catches it — the failure path under test.
    fs.symlinkSync(
      path.join(repo, 'packages', 'alpha', 'nowhere.md'),
      path.join(repo, 'packages', 'alpha', 'CLAUDE.md'),
    )

    await init()

    // The failed path is named, with its action.
    expect(lineFor(path.join('packages', 'alpha', 'CLAUDE.md'))).toMatch(
      /^ {2}failed {4}packages\/alpha\/CLAUDE\.md \(.+\)$/,
    )

    // The distinct summary line names the count and the fix.
    expect(loggedAt('warn')).toContain(FAILURE_SUMMARY)

    // `init`'s contract is shell setup: a guidance write failure must not turn it red.
    expect(process.exitCode ?? 0).toBe(0)

    // Continue-and-report: the package discovered AFTER the failing one was still written,
    // as were the root block and the rest of init's steps.
    expect(fs.readFileSync(path.join(repo, 'packages', 'beta', 'CLAUDE.md'), 'utf-8')).toContain(PACKAGE_MARKER_START)
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8')).toContain(AGENTS_MARKER_START)
    expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(true)
  })

  it('is idempotent — a second run reports nothing changed and logs no summary line', async () => {
    await init()

    const before = ['CLAUDE.md', 'packages/alpha/CLAUDE.md', 'packages/beta/CLAUDE.md'].map((rel) => {
      return fs.readFileSync(path.join(repo, rel), 'utf-8')
    })

    vi.clearAllMocks()
    resetGitStateCache()

    await init()

    const after = ['CLAUDE.md', 'packages/alpha/CLAUDE.md', 'packages/beta/CLAUDE.md'].map((rel) => {
      return fs.readFileSync(path.join(repo, rel), 'utf-8')
    })

    expect(after).toEqual(before)

    // Unchanged files are not logged, so no per-file line survives the second run.
    expect(lineFor('CLAUDE.md')).toBeUndefined()
    expect(loggedAt('warn')).not.toContain(FAILURE_SUMMARY)
    expect(
      loggedAt('info').some((line) => {
        return /^Agent-instruction files synced \(infra-kit .+\)$/.test(line)
      }),
    ).toBe(true)
  })

  it('skips the whole sync outside an infra-kit repo, without failing init', async () => {
    fs.rmSync(path.join(repo, 'infra-kit.json'))
    resetInfraKitConfigCache()

    await init()

    expect(fs.existsSync(path.join(repo, 'CLAUDE.md'))).toBe(false)
    expect(fs.existsSync(path.join(repo, 'packages', 'alpha', 'CLAUDE.md'))).toBe(false)
    expect(
      loggedAt('info').some((line) => {
        return line.startsWith('Agent-instruction files synced')
      }),
    ).toBe(false)
    expect(process.exitCode ?? 0).toBe(0)
  })
})
