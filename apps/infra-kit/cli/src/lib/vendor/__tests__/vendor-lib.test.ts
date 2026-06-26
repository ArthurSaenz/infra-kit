import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CURRENT_SCHEMA_VERSION,
  MANIFEST_FILE,
  buildFilesMap,
  compareToManifest,
  isUnknownSchema,
  readManifest,
  sha256,
  walkVendorTree,
  writeManifest,
} from 'src/lib/vendor'

let tmp: string

const write = (rel: string, content: string): void => {
  const full = path.join(tmp, rel)

  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-lib-test-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('walkVendorTree', () => {
  it('returns POSIX relative paths sorted byte-wise', () => {
    write('b.txt', 'b')
    write('a/nested.txt', 'n')
    write('a.txt', 'a')

    expect(walkVendorTree(tmp)).toEqual(['a.txt', 'a/nested.txt', 'b.txt'])
  })

  it('is deterministic regardless of creation order', () => {
    write('z.txt', 'z')
    write('m/x.txt', 'x')
    write('a.txt', 'a')

    const first = walkVendorTree(tmp)
    // Re-create in a different order in a fresh dir.
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-lib-test2-'))

    fs.writeFileSync(path.join(tmp2, 'a.txt'), 'a')
    fs.mkdirSync(path.join(tmp2, 'm'))
    fs.writeFileSync(path.join(tmp2, 'm', 'x.txt'), 'x')
    fs.writeFileSync(path.join(tmp2, 'z.txt'), 'z')
    const second = walkVendorTree(tmp2)

    fs.rmSync(tmp2, { recursive: true, force: true })

    expect(first).toEqual(second)
  })

  it('skips configured dirs, files, and suffixes (incl. .vitest-attachments union member)', () => {
    write('keep.ts', 'keep')
    write('node_modules/pkg/index.js', 'x')
    write('dist/out.js', 'x')
    write('.vitest-attachments/blob', 'x')
    write('.sync-manifest.json', '{}')
    write('.eslintcache', 'x')
    write('log.txt', 'x')
    write('build.tsbuildinfo', 'x')

    expect(walkVendorTree(tmp)).toEqual(['keep.ts'])
  })

  it('follows a symlink and hashes its target content (legacy semantics)', () => {
    write('real.txt', 'payload')
    fs.symlinkSync(path.join(tmp, 'real.txt'), path.join(tmp, 'link.txt'))

    const files = buildFilesMap(tmp)

    expect(Object.keys(files).sort()).toEqual(['link.txt', 'real.txt'])
    // Followed → identical content → identical hash.
    expect(files['link.txt']).toBe(files['real.txt'])
  })

  it('surfaces an explicit error for a dangling symlink', () => {
    fs.symlinkSync(path.join(tmp, 'does-not-exist'), path.join(tmp, 'dangling.txt'))

    expect(() => {
      return buildFilesMap(tmp)
    }).toThrow(/broken symlink or unreadable file/)
  })
})

describe('manifest read/write/compare', () => {
  it('write-then-check parity: a freshly written manifest reports no drift', () => {
    write('configs/a.js', 'aaa')
    write('packages/p/b.ts', 'bbb')

    const manifest = writeManifest(tmp, { source: 'starter-workspace', commit: 'abc123' })

    expect(manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(manifest.fileCount).toBe(2)

    const diff = compareToManifest(tmp, manifest)

    expect(diff).toEqual({ modified: [], added: [], removed: [] })
  })

  it('detects modified / added / removed files', () => {
    write('a.js', 'a')
    write('b.js', 'b')
    const manifest = writeManifest(tmp, { source: 's', commit: 'c' })

    fs.writeFileSync(path.join(tmp, 'a.js'), 'CHANGED')
    write('c.js', 'c')
    fs.rmSync(path.join(tmp, 'b.js'))

    const diff = compareToManifest(tmp, manifest)

    expect(diff.modified).toEqual(['a.js'])
    expect(diff.added).toEqual(['c.js'])
    expect(diff.removed).toEqual(['b.js'])
  })

  it('reads a legacy manifest with no schemaVersion as compatible', () => {
    write('a.js', 'a')
    const legacy = {
      source: 'starter-workspace',
      commit: 'deadbeef',
      syncedAt: new Date().toISOString(),
      fileCount: 1,
      files: { 'a.js': sha256(path.join(tmp, 'a.js')) },
    }

    fs.writeFileSync(path.join(tmp, MANIFEST_FILE), JSON.stringify(legacy))

    const manifest = readManifest(tmp)

    expect(manifest.schemaVersion).toBeUndefined()
    expect(isUnknownSchema(manifest)).toBe(false)
    expect(compareToManifest(tmp, manifest)).toEqual({ modified: [], added: [], removed: [] })
  })

  it('flags a newer schemaVersion as unknown (fail-closed)', () => {
    const manifest = { ...writeManifest(tmp, { source: 's', commit: 'c' }), schemaVersion: CURRENT_SCHEMA_VERSION + 1 }

    expect(isUnknownSchema(manifest)).toBe(true)
  })

  it('throws on a missing manifest', () => {
    expect(() => {
      return readManifest(tmp)
    }).toThrow(/Missing \.sync-manifest\.json/)
  })
})
