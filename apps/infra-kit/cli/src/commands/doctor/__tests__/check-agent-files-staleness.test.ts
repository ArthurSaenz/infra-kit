import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeAgentFiles } from 'src/commands/init/agent-files'
import { PACKAGE_MARKER_END, PACKAGE_MARKER_START, PACKAGE_VERSION_PREFIX } from 'src/lib/agent-guidance'
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'

import packageJson from '../../../../package.json' with { type: 'json' }
import { checkAgentFiles } from '../doctor'

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

const CURRENT_VERSION = packageJson.version

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
}

/** A well-formed package guidance block recording `version` — what `inspectPackageGuidance` calls `ok`. */
const packageBlock = (version: string): string => {
  return [
    '# pkg',
    '',
    PACKAGE_MARKER_START,
    `${PACKAGE_VERSION_PREFIX}${version} lib -->`,
    'Guidance body.',
    PACKAGE_MARKER_END,
    '',
  ].join('\n')
}

/** Add a workspace package at `packages/<name>`, optionally carrying a guidance block. */
const addPackage = (repo: string, name: string, blockVersion: string | null): void => {
  const dir = path.join(repo, 'packages', name)

  writeFile(path.join(dir, 'package.json'), `{ "name": "${name}" }\n`)

  if (blockVersion !== null) writeFile(path.join(dir, 'CLAUDE.md'), packageBlock(blockVersion))
}

const withTmpRepo = async (fn: (tmp: string) => Promise<void>, opts: { repo?: boolean } = {}): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-doctor-staleness-test-'))

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(tmp))

  if (opts.repo !== false) writeFile(path.join(tmp, 'infra-kit.json'), '{}\n')

  // getInfraKitConfigPaths memoizes on `cwd + homedir`, neither of which changes between
  // tests here (only the mocked getProjectRoot does), so the memo would hand this test the
  // PREVIOUS test's already-deleted tmp repo. Drop it on entry and exit.
  resetInfraKitConfigCache()

  try {
    await fn(tmp)
  } finally {
    resetInfraKitConfigCache()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const addWorkspaceFile = (repo: string): void => {
  writeFile(path.join(repo, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
}

const versionRow = async () => {
  const checks = await checkAgentFiles()

  expect(
    checks.map((check) => {
      return check.name
    }),
  ).toEqual(['CLAUDE.md block', 'Guidance version'])

  return checks[1]!
}

const messageOf = async (): Promise<string> => {
  return (await versionRow()).message
}

/** A root block recording `version`, with the `<!-- infra-kit:version … -->` line the doctor reads. */
const writeRootBlock = (repo: string, version: string): void => {
  writeFile(
    path.join(repo, 'CLAUDE.md'),
    ['<!-- infra-kit:begin -->', `<!-- infra-kit:version ${version} -->`, 'root', '<!-- infra-kit:end -->', ''].join(
      '\n',
    ),
  )
}

/** The current version with its minor bumped — newer than the running CLI whatever it is. */
const NEWER_VERSION = CURRENT_VERSION.replace(/^(\d+)\.(\d+)\.\d+$/u, (_m, major: string, minor: string) => {
  return `${major}.${Number(minor) + 1}.0`
})

describe('checkAgentFiles Guidance version row', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  /**
   * An omitted row reads as "nothing to report" when it means "never looked", so outside a repo both
   * rows are a `skip`, and a skip that never scanned a package must not carry a staleness verdict.
   */
  it('emits both rows outside an infra-kit repo, as skips with no staleness report', async () => {
    await withTmpRepo(
      async (tmp) => {
        addWorkspaceFile(tmp)
        addPackage(tmp, 'alpha', '0.0.1')

        const checks = await checkAgentFiles()

        expect(checks).toHaveLength(2)
        expect(
          checks.map((check) => {
            return check.status
          }),
        ).toEqual(['skip', 'skip'])
        expect(checks[1]!.message).not.toContain('package guidance blocks')
      },
      { repo: false },
    )
  })

  it('warns on blocks older than the running CLI and leaves the presence row a pass', async () => {
    await withTmpRepo(async (tmp) => {
      await writeAgentFiles()
      addWorkspaceFile(tmp)
      addPackage(tmp, 'alpha', '0.0.1')

      const checks = await checkAgentFiles()

      expect(checks[0]).toEqual({ name: 'CLAUDE.md block', status: 'pass', message: 'CLAUDE.md block present' })
      expect(checks[1]!.status).toBe('warn')
      expect(checks[1]!.message).toContain(
        `1 package guidance block was generated by an older infra-kit (oldest 0.0.1, current ${CURRENT_VERSION})`,
      )
      expect(checks[1]!.message).toContain('infra-kit audit --fix --all')
    })
  })

  it('warns on an older root block with the --root remediation', async () => {
    await withTmpRepo(async (tmp) => {
      writeRootBlock(tmp, '0.0.1')

      const row = await versionRow()

      expect(row.status).toBe('warn')
      expect(row.message).toBe('the root block is from infra-kit 0.0.1 — run: infra-kit audit --fix --root')
    })
  })

  it('warns that the CLI is behind when a block is newer than it', async () => {
    await withTmpRepo(async (tmp) => {
      writeRootBlock(tmp, CURRENT_VERSION)
      addWorkspaceFile(tmp)
      addPackage(tmp, 'alpha', NEWER_VERSION)
      addPackage(tmp, 'beta', '0.0.1')

      const row = await versionRow()

      expect(row.status).toBe('warn')
      expect(row.message).toContain(`newest ${NEWER_VERSION}, current ${CURRENT_VERSION}`)
      expect(row.message).toContain(`CLI behind the block, run: pnpm add -g infra-kit@${NEWER_VERSION}`)
    })
  })

  it('names the OLDEST stale version and counts only the stale blocks', async () => {
    await withTmpRepo(async (tmp) => {
      await writeAgentFiles()
      addWorkspaceFile(tmp)
      addPackage(tmp, 'alpha', '0.2.10')
      addPackage(tmp, 'beta', '0.0.9')
      addPackage(tmp, 'gamma', CURRENT_VERSION)
      // No CLAUDE.md at all — skipped, never counted as stale.
      addPackage(tmp, 'delta', null)

      const message = await messageOf()

      expect(message).toContain(
        `2 package guidance blocks were generated by an older infra-kit (oldest 0.0.9, current ${CURRENT_VERSION})`,
      )
    })
  })

  it('keeps the root-block-absent failure and still reports package staleness on its own row', async () => {
    await withTmpRepo(async (tmp) => {
      addWorkspaceFile(tmp)
      addPackage(tmp, 'alpha', '0.0.1')

      const checks = await checkAgentFiles()

      expect(checks[0]!.status).toBe('fail')
      expect(checks[0]!.message).toContain('Run: infra-kit setup --skip-tools')
      expect(checks[1]!.message).toContain('1 package guidance block was generated by an older infra-kit')
    })
  })

  it('degrades to no staleness text when there is no pnpm-workspace.yaml', async () => {
    await withTmpRepo(async (tmp) => {
      await writeAgentFiles()
      addPackage(tmp, 'alpha', '0.0.1')

      const row = await versionRow()

      expect(row.status).toBe('pass')
      expect(row.message).toBe(`guidance blocks match infra-kit ${CURRENT_VERSION}`)
    })
  })

  it('degrades to no staleness text when pnpm-workspace.yaml is malformed', async () => {
    await withTmpRepo(async (tmp) => {
      await writeAgentFiles()
      writeFile(path.join(tmp, 'pnpm-workspace.yaml'), 'packages: [unclosed\n  - "packages/*"\n')
      addPackage(tmp, 'alpha', '0.0.1')

      const message = await messageOf()

      expect(message).toBe(`guidance blocks match infra-kit ${CURRENT_VERSION}`)
    })
  })

  it('says nothing when every package block is at the running version', async () => {
    await withTmpRepo(async (tmp) => {
      await writeAgentFiles()
      addWorkspaceFile(tmp)
      addPackage(tmp, 'alpha', CURRENT_VERSION)

      const message = await messageOf()

      expect(message).toBe(`guidance blocks match infra-kit ${CURRENT_VERSION}`)
      expect(message).not.toContain('older infra-kit')
    })
  })
})
