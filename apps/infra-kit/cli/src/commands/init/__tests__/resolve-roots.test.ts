import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'

import { resolveGitRoot, resolveGitRootForWrites, resolveInfraKitRoot } from '../agent-files'

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

/** The skip that covers all four gated steps — guidance, pointer, install, `.mcp.json`. */
const GIT_ROOT_SKIP = /^Skipped agent-instruction files, the plugin pointer, the plugin install and \.mcp\.json —/

/** The guidance-only skip: the other three steps ran. */
const GUIDANCE_ONLY_SKIP = /^Skipped agent-instruction files — no infra-kit\.json at the repo root/

let home: string
let repo: string

/** Every string `logger.info` was called with during the current test. */
const infoLines = (): string[] => {
  return vi.mocked(logger.info).mock.calls.map((call) => {
    return typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0])
  })
}

const linesMatching = (pattern: RegExp): string[] => {
  return infoLines().filter((line) => {
    return pattern.test(line)
  })
}

beforeEach(() => {
  vi.clearAllMocks()

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-roots-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-roots-repo-'))

  vi.spyOn(os, 'homedir').mockReturnValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

/**
 * The shared predicate, where every assertion is paired with a SILENCE assertion.
 *
 * Silence is the contract here, not an implementation detail: `doctor` imports this same function
 * read-only to decide whether the `MCP server key` row is answerable, and while the predicate
 * announced, `doctor` printed `initCore`'s "Skipped … the plugin install and .mcp.json" as stderr line 1
 * — above its own report header — in every non-git directory and in `$HOME`. Without these mirrors,
 * nothing stops the log moving back in here.
 */
describe('resolveGitRoot', () => {
  it('returns the git toplevel for a repo that is not $HOME', async () => {
    vi.mocked(getProjectRoot).mockResolvedValue(repo)

    await expect(resolveGitRoot()).resolves.toBe(repo)
    expect(infoLines()).toHaveLength(0)
  })

  it('returns null and says nothing when the git seam answers blank stdout', async () => {
    // `getProjectRoot` is `result.stdout.trim()` and rejects only when the shell-out fails,
    // so blank stdout RESOLVES as ''. Accepting it would write cwd-relative files while the
    // caller announces the wrong path, and `'' !== homedir()` would let the $HOME check pass.
    vi.mocked(getProjectRoot).mockResolvedValue('')

    await expect(resolveGitRoot()).resolves.toBeNull()
    expect(infoLines()).toHaveLength(0)
  })

  it('returns null and says nothing when the git seam answers whitespace-only stdout', async () => {
    vi.mocked(getProjectRoot).mockResolvedValue('  \n\t')

    await expect(resolveGitRoot()).resolves.toBeNull()
    expect(infoLines()).toHaveLength(0)
  })

  it('returns null and says nothing when the resolved root is $HOME', async () => {
    // "Inside a git repo" does not protect $HOME: git-managed dotfiles put a repo there.
    vi.mocked(getProjectRoot).mockResolvedValue(home)

    await expect(resolveGitRoot()).resolves.toBeNull()
    expect(infoLines()).toHaveLength(0)
  })

  it('returns null and says nothing when the git seam rejects', async () => {
    vi.mocked(getProjectRoot).mockRejectedValue(new Error('not a git repository'))

    await expect(resolveGitRoot()).resolves.toBeNull()
    expect(infoLines()).toHaveLength(0)
  })
})

/**
 * The writer's variant: the same predicate plus the announcement. `initCore` is the only caller, because
 * it is the only one for whom the skip is otherwise invisible — the pointer, the install and the
 * `.mcp.json` write print nothing when they do not run.
 */
describe('resolveGitRootForWrites', () => {
  it('returns the git toplevel, announcing nothing, for a repo that is not $HOME', async () => {
    vi.mocked(getProjectRoot).mockResolvedValue(repo)

    await expect(resolveGitRootForWrites()).resolves.toBe(repo)
    expect(linesMatching(GIT_ROOT_SKIP)).toHaveLength(0)
  })

  it('returns null and logs a skip when the git seam answers blank stdout', async () => {
    vi.mocked(getProjectRoot).mockResolvedValue('')

    await expect(resolveGitRootForWrites()).resolves.toBeNull()
    expect(linesMatching(GIT_ROOT_SKIP)).toHaveLength(1)
  })

  it('returns null and logs a skip when the git seam answers whitespace-only stdout', async () => {
    vi.mocked(getProjectRoot).mockResolvedValue('  \n\t')

    await expect(resolveGitRootForWrites()).resolves.toBeNull()
    expect(linesMatching(GIT_ROOT_SKIP)).toHaveLength(1)
  })

  it('returns null and logs a skip when the resolved root is $HOME', async () => {
    vi.mocked(getProjectRoot).mockResolvedValue(home)

    await expect(resolveGitRootForWrites()).resolves.toBeNull()
    expect(linesMatching(GIT_ROOT_SKIP)).toHaveLength(1)
  })

  it('returns null and logs a skip — not a debug swallow — when the git seam rejects', async () => {
    vi.mocked(getProjectRoot).mockRejectedValue(new Error('not a git repository'))

    await expect(resolveGitRootForWrites()).resolves.toBeNull()
    expect(linesMatching(GIT_ROOT_SKIP)).toHaveLength(1)
    expect(vi.mocked(logger.debug)).not.toHaveBeenCalled()
  })
})

describe('resolveInfraKitRoot', () => {
  it('returns the root when infra-kit.json is present', async () => {
    vi.mocked(getProjectRoot).mockResolvedValue(repo)
    fs.writeFileSync(path.join(repo, 'infra-kit.json'), '{}\n', 'utf-8')

    await expect(resolveInfraKitRoot()).resolves.toBe(repo)
    expect(infoLines()).toHaveLength(0)
  })

  it('returns null with the guidance-only skip in a git repo that has no infra-kit.json', async () => {
    vi.mocked(getProjectRoot).mockResolvedValue(repo)

    await expect(resolveInfraKitRoot()).resolves.toBeNull()
    expect(linesMatching(GUIDANCE_ONLY_SKIP)).toHaveLength(1)
    // The other three steps are NOT gated on this predicate, so their skip must not fire.
    expect(linesMatching(GIT_ROOT_SKIP)).toHaveLength(0)
  })

  it('says nothing at all when the git gate already refused', async () => {
    vi.mocked(getProjectRoot).mockResolvedValue('')

    await expect(resolveInfraKitRoot()).resolves.toBeNull()
    // Not this gate's line to print: `initCore` announces the git refusal itself through
    // `resolveGitRootForWrites`, so announcing it here too is the duplicate that fix removed.
    expect(linesMatching(GIT_ROOT_SKIP)).toHaveLength(0)
    expect(linesMatching(GUIDANCE_ONLY_SKIP)).toHaveLength(0)
  })
})
