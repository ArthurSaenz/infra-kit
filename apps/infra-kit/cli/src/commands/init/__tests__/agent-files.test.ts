import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectRoot, getRepoName } from 'src/lib/git-utils'

import {
  AGENTS_IMPORT_END,
  AGENTS_IMPORT_START,
  AGENTS_MARKER_END,
  AGENTS_MARKER_START,
  writeAgentFiles,
} from '../agent-files'

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

  it('writes the full guidance block only to CLAUDE.md, and creates no other files, on a fresh repo', async () => {
    await withTmpRepo(async (tmp) => {
      const result = await writeAgentFiles()

      expect(result.skipped).toBe(false)
      expect(result.root).toBe(tmp)

      const claude = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8')

      expect(claude).toContain(AGENTS_MARKER_START)
      expect(claude).toContain(AGENTS_MARKER_END)
      expect(claude).toContain('<!-- infra-kit:version ')
      expect(claude).toContain('# infra-kit')
      // The migrated `@AGENTS.md` import region must never appear.
      expect(claude).not.toContain(AGENTS_IMPORT_START)
      expect(claude).not.toContain('@AGENTS.md')

      // CLAUDE.md is the only output — infra-kit no longer touches AGENTS.md or .cursor.
      expect(fs.existsSync(path.join(tmp, 'AGENTS.md'))).toBe(false)
      expect(fs.existsSync(path.join(tmp, '.cursor'))).toBe(false)
    })
  })

  it('preserves existing hand-authored CLAUDE.md content and appends the block after it', async () => {
    await withTmpRepo(async (tmp) => {
      const claudePath = path.join(tmp, 'CLAUDE.md')
      const userContent = '# CLAUDE.md\n\n## Ticket Naming Convention\n\n- `[FE]` — frontend\n- `[BE]` — backend\n'

      writeFile(claudePath, userContent)

      await writeAgentFiles()

      const updated = fs.readFileSync(claudePath, 'utf-8')

      expect(updated).toContain('## Ticket Naming Convention')
      expect(updated).toContain('`[FE]` — frontend')
      expect(updated).toContain(AGENTS_MARKER_START)
      // The managed block lands AFTER the hand-authored content.
      expect(updated.indexOf('## Ticket Naming Convention')).toBeLessThan(updated.indexOf(AGENTS_MARKER_START))
    })
  })

  it('is idempotent — a second run does not duplicate the block and reports unchanged (same CLI version)', async () => {
    await withTmpRepo(async (tmp) => {
      await writeAgentFiles()
      const first = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8')

      const second = await writeAgentFiles()
      const after = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8')

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
        expect(fs.existsSync(path.join(tmp, 'CLAUDE.md'))).toBe(false)
      },
      { repo: false },
    )
  })

  it('refuses to write through a symlinked CLAUDE.md', async () => {
    await withTmpRepo(async (tmp) => {
      const realTarget = path.join(tmp, 'elsewhere.md')

      writeFile(realTarget, 'sensitive')
      fs.symlinkSync(realTarget, path.join(tmp, 'CLAUDE.md'))

      await expect(writeAgentFiles()).rejects.toThrow(/symlink/)
    })
  })

  it('backs up an existing CLAUDE.md before overwriting', async () => {
    await withTmpRepo(async (tmp) => {
      writeFile(path.join(tmp, 'CLAUDE.md'), 'previous content without markers\n')

      await writeAgentFiles()

      const backups = fs.readdirSync(tmp).filter((f) => {
        return f.startsWith('CLAUDE.md.backup.')
      })

      expect(backups).toHaveLength(1)
      expect(fs.readFileSync(path.join(tmp, backups[0]!), 'utf-8')).toContain('previous content without markers')
    })
  })

  describe('legacy AGENTS.md migration', () => {
    /** Seed a repo in the pre-migration state: AGENTS.md (full block) + CLAUDE.md (@AGENTS.md import). */
    const seedLegacy = async (
      tmp: string,
      opts: { agentsExtra?: string; claudeExtra?: string } = {},
    ): Promise<void> => {
      const agentsBlock = `${AGENTS_MARKER_START}\n# infra-kit\nlegacy body\n${AGENTS_MARKER_END}\n`
      const importBlock = `${AGENTS_IMPORT_START}\n@AGENTS.md\n${AGENTS_IMPORT_END}\n`

      writeFile(path.join(tmp, 'AGENTS.md'), `${opts.agentsExtra ?? ''}${agentsBlock}`)
      writeFile(path.join(tmp, 'CLAUDE.md'), `${opts.claudeExtra ?? ''}${importBlock}`)
    }

    it('removes a purely-generated AGENTS.md (with a backup) and strips the @AGENTS.md import from CLAUDE.md', async () => {
      await withTmpRepo(async (tmp) => {
        await seedLegacy(tmp)

        await writeAgentFiles()

        // AGENTS.md is gone, but a backup survives.
        expect(fs.existsSync(path.join(tmp, 'AGENTS.md'))).toBe(false)
        const backups = fs.readdirSync(tmp).filter((f) => {
          return f.startsWith('AGENTS.md.backup.')
        })

        expect(backups).toHaveLength(1)

        // CLAUDE.md now carries the full block and no longer imports @AGENTS.md.
        const claude = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8')

        expect(claude).toContain(AGENTS_MARKER_START)
        expect(claude).not.toContain(AGENTS_IMPORT_START)
        expect(claude).not.toContain('@AGENTS.md')
      })
    })

    it('retains an AGENTS.md that has hand-authored content (block removed, file kept, backup made)', async () => {
      await withTmpRepo(async (tmp) => {
        await seedLegacy(tmp, { agentsExtra: '# My own notes\n\nkeep me\n\n' })

        await writeAgentFiles()

        // File retained with hand content; the infra-kit block is stripped.
        expect(fs.existsSync(path.join(tmp, 'AGENTS.md'))).toBe(true)
        const agents = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf-8')

        expect(agents).toContain('# My own notes')
        expect(agents).toContain('keep me')
        expect(agents).not.toContain(AGENTS_MARKER_START)

        // A backup of the pre-strip file exists.
        const backups = fs.readdirSync(tmp).filter((f) => {
          return f.startsWith('AGENTS.md.backup.')
        })

        expect(backups).toHaveLength(1)
      })
    })

    it('leaves an AGENTS.md with no infra-kit block untouched (not ours)', async () => {
      await withTmpRepo(async (tmp) => {
        const handAuthored = '# AGENTS\n\nentirely hand-written, no markers\n'

        writeFile(path.join(tmp, 'AGENTS.md'), handAuthored)

        await writeAgentFiles()

        expect(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf-8')).toBe(handAuthored)
        const backups = fs.readdirSync(tmp).filter((f) => {
          return f.startsWith('AGENTS.md.backup.')
        })

        expect(backups).toHaveLength(0)
      })
    })

    it('is idempotent after migration — a second run finds nothing left to migrate', async () => {
      await withTmpRepo(async (tmp) => {
        await seedLegacy(tmp)
        await writeAgentFiles()

        const second = await writeAgentFiles()

        expect(
          second.written.every((w) => {
            return w.action === 'unchanged'
          }),
        ).toBe(true)
      })
    })
  })

  it('does not touch a pre-existing .cursor/rules file — infra-kit no longer supports Cursor rules', async () => {
    await withTmpRepo(async (tmp) => {
      const cursorPath = path.join(tmp, '.cursor', 'rules', 'infra-kit.mdc')
      // Even a file that carries our managed block is left completely alone now.
      const existing = `---\ndescription: x\n---\n${AGENTS_MARKER_START}\n# infra-kit\nold body\n${AGENTS_MARKER_END}\n`

      writeFile(cursorPath, existing)

      await writeAgentFiles()

      // Untouched: same content, no backup, no deletion.
      expect(fs.readFileSync(cursorPath, 'utf-8')).toBe(existing)
      const backups = fs.readdirSync(path.join(tmp, '.cursor', 'rules')).filter((f) => {
        return f.startsWith('infra-kit.mdc.backup.')
      })

      expect(backups).toHaveLength(0)
    })
  })
})
