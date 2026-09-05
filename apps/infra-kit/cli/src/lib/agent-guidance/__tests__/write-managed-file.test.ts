import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { upsertManagedBlock } from 'src/lib/managed-block'

import { PACKAGE_MARKER_END, PACKAGE_MARKER_START } from '../markers'
import {
  assertNotSymlink,
  assertOutsideMarkersUnchanged,
  classifyGitState,
  resetGitStateCache,
  writeManaged,
} from '../write-managed-file'

/* eslint-disable sonarjs/no-os-command-from-path -- hermetic test fixture drives the real `git` CLI */
const git = (cwd: string, args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}
/* eslint-enable sonarjs/no-os-command-from-path */

const makeTmpDir = (): string => {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-write-managed-'))
}

/** A temp directory that is a git repo with one commit, so HEAD exists. */
const makeTmpRepo = (): string => {
  const dir = makeTmpDir()

  git(dir, ['init'])
  fs.writeFileSync(path.join(dir, '.gitkeep'), '', 'utf-8')
  git(dir, ['add', '.gitkeep'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'])

  return dir
}

/** Commit `filePath` into the repo at `repo`. */
const commitFile = (repo: string, filePath: string): void => {
  git(repo, ['add', path.relative(repo, filePath)])
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add'])
}

const backupsIn = (dir: string, basename: string): string[] => {
  return fs.readdirSync(dir).filter((entry) => {
    return entry.startsWith(`${basename}.backup.`)
  })
}

describe('classifyGitState', () => {
  beforeEach(() => {
    resetGitStateCache()
  })

  it('reports a tracked, unmodified file as recoverable from git', () => {
    const repo = makeTmpRepo()
    const filePath = path.join(repo, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'committed\n', 'utf-8')
    commitFile(repo, filePath)

    expect(classifyGitState(filePath)).toBe('tracked-clean')
  })

  it('reports a tracked but modified file as needing a backup', () => {
    const repo = makeTmpRepo()
    const filePath = path.join(repo, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'committed\n', 'utf-8')
    commitFile(repo, filePath)
    fs.writeFileSync(filePath, 'committed\nplus uncommitted edits\n', 'utf-8')

    expect(classifyGitState(filePath)).toBe('needs-backup')
  })

  it('reports an untracked file as needing a backup', () => {
    const repo = makeTmpRepo()
    const filePath = path.join(repo, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'never committed\n', 'utf-8')

    expect(classifyGitState(filePath)).toBe('needs-backup')
  })

  it('reports a file outside any git repo as needing a backup', () => {
    const dir = makeTmpDir()
    const filePath = path.join(dir, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'loose\n', 'utf-8')

    expect(classifyGitState(filePath)).toBe('needs-backup')
  })
})

describe('writeManaged backup policy', () => {
  beforeEach(() => {
    resetGitStateCache()
  })

  it('writes no backup for a tracked, clean package file under the git-aware policy', () => {
    const repo = makeTmpRepo()
    const filePath = path.join(repo, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'committed\n', 'utf-8')
    commitFile(repo, filePath)

    expect(writeManaged(filePath, 'rewritten\n', { backup: 'git-aware' })).toBe('updated')
    expect(backupsIn(repo, 'CLAUDE.md')).toHaveLength(0)
  })

  it('writes a backup for a dirty file under the git-aware policy', () => {
    const repo = makeTmpRepo()
    const filePath = path.join(repo, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'committed\n', 'utf-8')
    commitFile(repo, filePath)
    fs.writeFileSync(filePath, 'dirty\n', 'utf-8')

    writeManaged(filePath, 'rewritten\n', { backup: 'git-aware' })

    expect(backupsIn(repo, 'CLAUDE.md')).toHaveLength(1)
  })

  it('writes a backup for an untracked file under the git-aware policy', () => {
    const repo = makeTmpRepo()
    const filePath = path.join(repo, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'untracked\n', 'utf-8')

    writeManaged(filePath, 'rewritten\n', { backup: 'git-aware' })

    expect(backupsIn(repo, 'CLAUDE.md')).toHaveLength(1)
  })

  it('writes a backup outside a git repo under the git-aware policy', () => {
    const dir = makeTmpDir()
    const filePath = path.join(dir, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'loose\n', 'utf-8')

    writeManaged(filePath, 'rewritten\n', { backup: 'git-aware' })

    expect(backupsIn(dir, 'CLAUDE.md')).toHaveLength(1)
  })

  it('always backs up under the root policy, even for a tracked, clean file', () => {
    const repo = makeTmpRepo()
    const filePath = path.join(repo, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'committed\n', 'utf-8')
    commitFile(repo, filePath)

    writeManaged(filePath, 'rewritten\n', { backup: 'always' })

    expect(backupsIn(repo, 'CLAUDE.md')).toHaveLength(1)
  })

  it('reports byte-identical content as unchanged and writes no backup', () => {
    const dir = makeTmpDir()
    const filePath = path.join(dir, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'same\n', 'utf-8')

    expect(writeManaged(filePath, 'same\n', { backup: 'always' })).toBe('unchanged')
    expect(backupsIn(dir, 'CLAUDE.md')).toHaveLength(0)
  })

  it('reports a fresh file as created', () => {
    const dir = makeTmpDir()

    expect(writeManaged(path.join(dir, 'nested', 'CLAUDE.md'), 'new\n', { backup: 'always' })).toBe('created')
  })
})

describe('assertNotSymlink', () => {
  it('refuses a symlink whose target exists', () => {
    const dir = makeTmpDir()
    const target = path.join(dir, 'elsewhere.md')

    fs.writeFileSync(target, 'sensitive\n', 'utf-8')
    fs.symlinkSync(target, path.join(dir, 'CLAUDE.md'))

    expect(() => {
      return assertNotSymlink(path.join(dir, 'CLAUDE.md'))
    }).toThrow(/symlink/)
  })

  it('refuses a DANGLING symlink — the case an existsSync gate misses', () => {
    const dir = makeTmpDir()
    const linkPath = path.join(dir, 'CLAUDE.md')

    fs.symlinkSync(path.join(dir, 'does-not-exist.md'), linkPath)

    expect(fs.existsSync(linkPath)).toBe(false)
    expect(() => {
      return assertNotSymlink(linkPath)
    }).toThrow(/symlink/)
    expect(() => {
      return writeManaged(linkPath, 'body\n', { backup: 'always' })
    }).toThrow(/symlink/)
    // The write never went through the link.
    expect(fs.existsSync(path.join(dir, 'does-not-exist.md'))).toBe(false)
  })

  it('is silent for an absent path and for a regular file', () => {
    const dir = makeTmpDir()

    fs.writeFileSync(path.join(dir, 'real.md'), 'x\n', 'utf-8')

    expect(() => {
      assertNotSymlink(path.join(dir, 'absent.md'))
      assertNotSymlink(path.join(dir, 'real.md'))
    }).not.toThrow()
  })
})

describe('marker-boundary integrity', () => {
  const body = 'BODY'
  const upsert = (content: string, nextBody: string): string => {
    return upsertManagedBlock({
      content,
      body: nextBody,
      startMarker: PACKAGE_MARKER_START,
      endMarker: PACKAGE_MARKER_END,
      placement: 'replace-in-place',
    })
  }

  it('keeps every byte outside the markers identical across an update', () => {
    const first = upsert('# Notes\n\nabove\n', body)
    const withProse = `${first}\nbelow the block\n`
    const second = upsert(withProse, 'REGENERATED BODY')

    expect(() => {
      assertOutsideMarkersUnchanged(withProse, second, PACKAGE_MARKER_START, PACKAGE_MARKER_END)
    }).not.toThrow()
    expect(second).toContain('# Notes')
    expect(second).toContain('below the block')
    expect(second).toContain('REGENERATED BODY')
  })

  it('throws when text outside the markers was altered', () => {
    const before = upsert('# Notes\n\nabove\n', body)
    const tampered = before.replace('above', 'ABOVE')

    expect(() => {
      assertOutsideMarkersUnchanged(before, tampered, PACKAGE_MARKER_START, PACKAGE_MARKER_END)
    }).toThrow(/outside the managed markers/)
  })

  it('is a no-op on first insertion, which legitimately normalizes trailing newlines', () => {
    const dir = makeTmpDir()
    const filePath = path.join(dir, 'CLAUDE.md')
    const original = '# Notes\n\nkeep me\n\n\n\n'

    fs.writeFileSync(filePath, original, 'utf-8')

    const next = upsert(original, body)

    expect(writeManaged(filePath, next, { backup: 'always' })).toBe('updated')

    const written = fs.readFileSync(filePath, 'utf-8')

    expect(written).toContain('keep me')
    expect(written).toContain(PACKAGE_MARKER_START)
    // The blank-line run collapsed and the file ends in exactly one newline.
    expect(written).not.toContain('keep me\n\n\n')
    expect(written.endsWith(`${PACKAGE_MARKER_END}\n`)).toBe(true)
    // First insertion is exempt from the assert; running it anyway must not throw,
    // because `original` carries no block for the comparison to anchor on.
    expect(() => {
      assertOutsideMarkersUnchanged(original, written, PACKAGE_MARKER_START, PACKAGE_MARKER_END)
    }).not.toThrow()
  })
})
