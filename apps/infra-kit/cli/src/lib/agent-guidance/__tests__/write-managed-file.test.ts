import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { upsertManagedBlock } from 'src/lib/managed-block'

import { PACKAGE_MARKER_END, PACKAGE_MARKER_START } from '../markers'
import { assertNotSymlink, assertOutsideMarkersUnchanged, writeManaged } from '../write-managed-file'

const makeTmpDir = (): string => {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-write-managed-'))
}

/** Sibling files a former backup policy would have left next to `basename`. */
const backupsIn = (dir: string, basename: string): string[] => {
  return fs.readdirSync(dir).filter((entry) => {
    return entry.startsWith(`${basename}.backup.`)
  })
}

describe('writeManaged', () => {
  it('overwrites an existing file in place, leaving no backup sibling', () => {
    const dir = makeTmpDir()
    const filePath = path.join(dir, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'previous\n', 'utf-8')

    expect(writeManaged(filePath, 'rewritten\n')).toBe('updated')
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('rewritten\n')
    expect(backupsIn(dir, 'CLAUDE.md')).toHaveLength(0)
  })

  it('reports byte-identical content as unchanged', () => {
    const dir = makeTmpDir()
    const filePath = path.join(dir, 'CLAUDE.md')

    fs.writeFileSync(filePath, 'same\n', 'utf-8')

    expect(writeManaged(filePath, 'same\n')).toBe('unchanged')
  })

  it('reports a fresh file as created', () => {
    const dir = makeTmpDir()

    expect(writeManaged(path.join(dir, 'nested', 'CLAUDE.md'), 'new\n')).toBe('created')
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
      return writeManaged(linkPath, 'body\n')
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

    expect(writeManaged(filePath, next)).toBe('updated')

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
