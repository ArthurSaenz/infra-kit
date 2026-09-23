import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readManifest, writeManifest } from 'src/lib/vendor'
import { manifestPathsAfterApply } from 'src/lib/vendor/sync'

let tmp: string

const write = (rel: string, content: string): void => {
  const full = path.join(tmp, rel)

  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-sync-manifest-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('manifest after an uncommitted delete', () => {
  it('leaves the deleted path out even though the index still lists it, and hashing does not throw', () => {
    write('vendor/README.md', 'readme')
    write('vendor/configs/kept.js', 'kept')
    write('vendor/configs/serverless-config/owned.ts', 'owned')
    write('vendor/configs/ignored-build/out.js', 'ignored')

    const paths = manifestPathsAfterApply(
      [{ vendored: true, targetPaths: ['vendor/configs/kept.js'] }],
      // The index after the apply, before any commit: `gone.js` was deleted from disk but is still listed.
      [
        'vendor/README.md',
        'vendor/.sync-manifest.json',
        'vendor/configs/gone.js',
        'vendor/configs/serverless-config/owned.ts',
      ],
      ['vendor/configs/gone.js'],
    )

    expect(paths).toEqual(['README.md', 'configs/kept.js', 'configs/serverless-config/owned.ts'])

    const vendorRoot = path.join(tmp, 'vendor')

    expect(() => {
      writeManifest(vendorRoot, { source: 'starter', commit: 'abc' }, paths)
    }).not.toThrow()
    expect(Object.keys(readManifest(vendorRoot).files)).toEqual(paths)
  })

  it('ignores non-vendored entries and paths outside vendor/', () => {
    expect(manifestPathsAfterApply([{ vendored: false, targetPaths: ['.claude/a.md'] }], ['.claude/a.md'], [])).toEqual(
      ['README.md'],
    )
  })

  it('keeps the working-tree walk when no paths are passed', () => {
    write('vendor/untracked-but-present.txt', 'x')

    const manifest = writeManifest(path.join(tmp, 'vendor'), { source: 'starter', commit: 'abc' })

    expect(Object.keys(manifest.files)).toEqual(['untracked-but-present.txt'])
  })
})
