import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeAgentFiles } from 'src/commands/init/agent-files'
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'

import { checkAgentFiles } from '../doctor'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
  }
})

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
}

const withTmpRepo = async (fn: (tmp: string) => Promise<void>, opts: { repo?: boolean } = {}): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-doctor-agents-test-'))

  vi.mocked(getProjectRoot).mockResolvedValue(tmp)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(tmp))

  if (opts.repo !== false) {
    writeFile(path.join(tmp, 'infra-kit.json'), '{"environments":["dev"]}\n')
  }

  try {
    await fn(tmp)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const statusOf = (checks: { name: string; status: string }[], name: string): string | undefined => {
  return checks.find((c) => {
    return c.name === name
  })?.status
}

describe('checkAgentFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns no checks outside an infra-kit repo (never crashes)', async () => {
    await withTmpRepo(
      async () => {
        await expect(checkAgentFiles()).resolves.toEqual([])
      },
      { repo: false },
    )
  })

  it('passes all three checks right after init runs the agent-files step', async () => {
    await withTmpRepo(async () => {
      await writeAgentFiles()

      const checks = await checkAgentFiles()

      expect(statusOf(checks, 'AGENTS.md block')).toBe('pass')
      expect(statusOf(checks, 'CLAUDE.md import')).toBe('pass')
      expect(statusOf(checks, '.cursor/rules block')).toBe('pass')
    })
  })

  it('flags AGENTS.md present but CLAUDE.md import removed', async () => {
    await withTmpRepo(async (tmp) => {
      await writeAgentFiles()
      // User deletes CLAUDE.md (drops the @AGENTS.md import) but keeps AGENTS.md.
      fs.rmSync(path.join(tmp, 'CLAUDE.md'))

      const checks = await checkAgentFiles()

      expect(statusOf(checks, 'AGENTS.md block')).toBe('pass')
      expect(statusOf(checks, 'CLAUDE.md import')).toBe('fail')
    })
  })

  it('flags a missing .cursor/rules block', async () => {
    await withTmpRepo(async (tmp) => {
      await writeAgentFiles()
      fs.rmSync(path.join(tmp, '.cursor', 'rules', 'infra-kit.mdc'))

      const checks = await checkAgentFiles()

      expect(statusOf(checks, '.cursor/rules block')).toBe('fail')
    })
  })

  it('flags a missing AGENTS.md block', async () => {
    await withTmpRepo(async (tmp) => {
      await writeAgentFiles()
      fs.rmSync(path.join(tmp, 'AGENTS.md'))

      const checks = await checkAgentFiles()

      expect(statusOf(checks, 'AGENTS.md block')).toBe('fail')
    })
  })
})
