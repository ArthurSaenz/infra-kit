import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectRoot, getRepoName } from 'src/lib/git-utils'

import { AGENTS_IMPORT_START, AGENTS_MARKER_END, AGENTS_MARKER_START, writeAgentFiles } from '../agent-files'

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

/** A tmp dir that is a "valid repo" (has infra-kit.json) unless `repo: false`. */
const withTmpRepo = async (fn: (tmp: string) => Promise<void>, opts: { repo?: boolean } = {}): Promise<void> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-agents-test-'))

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

describe('writeAgentFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates AGENTS.md, the CLAUDE.md import, and the .cursor rule on a fresh repo', async () => {
    await withTmpRepo(async (tmp) => {
      const result = await writeAgentFiles()

      expect(result.skipped).toBe(false)
      expect(result.root).toBe(tmp)

      const agents = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf-8')

      expect(agents).toContain(AGENTS_MARKER_START)
      expect(agents).toContain(AGENTS_MARKER_END)
      expect(agents).toContain('<!-- infra-kit:version ')

      const claude = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8')

      expect(claude).toContain(AGENTS_IMPORT_START)
      expect(claude).toContain('@AGENTS.md')

      const cursor = fs.readFileSync(path.join(tmp, '.cursor', 'rules', 'infra-kit.mdc'), 'utf-8')

      expect(cursor).toContain('alwaysApply: true')
      expect(cursor).toContain(AGENTS_MARKER_START)
    })
  })

  it('preserves existing hand-authored CLAUDE.md content verbatim (ticket conventions)', async () => {
    await withTmpRepo(async (tmp) => {
      const claudePath = path.join(tmp, 'CLAUDE.md')
      const userContent = '# CLAUDE.md\n\n## Ticket Naming Convention\n\n- `[FE]` — frontend\n- `[BE]` — backend\n'

      writeFile(claudePath, userContent)

      await writeAgentFiles()

      const updated = fs.readFileSync(claudePath, 'utf-8')

      expect(updated).toContain('## Ticket Naming Convention')
      expect(updated).toContain('`[FE]` — frontend')
      expect(updated).toContain(AGENTS_IMPORT_START)
    })
  })

  it('is idempotent — a second run does not duplicate the block', async () => {
    await withTmpRepo(async (tmp) => {
      await writeAgentFiles()
      const first = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf-8')

      const second = await writeAgentFiles()
      const after = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf-8')

      expect(after).toBe(first)
      expect(after.match(new RegExp(AGENTS_MARKER_START, 'g'))?.length).toBe(1)
      expect(
        second.written.every((w) => {
          return w.action === 'unchanged'
        }),
      ).toBe(true)
    })
  })

  it('is a no-op outside an infra-kit repo (no infra-kit.json)', async () => {
    await withTmpRepo(
      async (tmp) => {
        const result = await writeAgentFiles()

        expect(result.skipped).toBe(true)
        expect(result.root).toBeNull()
        expect(fs.existsSync(path.join(tmp, 'AGENTS.md'))).toBe(false)
      },
      { repo: false },
    )
  })

  it('refuses to write through a symlinked AGENTS.md', async () => {
    await withTmpRepo(async (tmp) => {
      const realTarget = path.join(tmp, 'elsewhere.md')

      writeFile(realTarget, 'sensitive')
      fs.symlinkSync(realTarget, path.join(tmp, 'AGENTS.md'))

      await expect(writeAgentFiles()).rejects.toThrow(/symlink/)
    })
  })

  it('backs up an existing AGENTS.md before overwriting', async () => {
    await withTmpRepo(async (tmp) => {
      writeFile(path.join(tmp, 'AGENTS.md'), 'previous content without markers\n')

      await writeAgentFiles()

      const backups = fs.readdirSync(tmp).filter((f) => {
        return f.startsWith('AGENTS.md.backup.')
      })

      expect(backups.length).toBe(1)
      expect(fs.readFileSync(path.join(tmp, backups[0]!), 'utf-8')).toContain('previous content without markers')
    })
  })
})
