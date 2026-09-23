import { describe, expect, it } from 'vitest'

import { parsePorcelainZ } from '../probe'
import { parseLsFilesStage } from '../tracked-files'

describe('parseLsFilesStage', () => {
  it('keeps blob and link modes, drops gitlinks, excluded segments and duplicate stages', () => {
    const stdout = [
      '100644 aaa 0\t.claude/a.md',
      '100755 bbb 0\tbin/run',
      '120000 ccc 0\t.agents/link',
      '160000 ddd 0\tsubmodule',
      '100644 eee 0\tvendor/configs/serverless-config/x.ts',
      '100644 fff 1\tconflict.txt',
      '100644 ggg 2\tconflict.txt',
      '',
    ].join('\0')

    expect(parseLsFilesStage(stdout, ['serverless-config'])).toEqual([
      { path: '.claude/a.md', mode: '100644' },
      { path: 'bin/run', mode: '100755' },
      { path: '.agents/link', mode: '120000' },
      { path: 'conflict.txt', mode: '100644' },
    ])
  })

  it('keeps tabs and spaces inside a path', () => {
    expect(parseLsFilesStage('100644 aaa 0\troutes/[id] x.tsx\0', [])).toEqual([
      { path: 'routes/[id] x.tsx', mode: '100644' },
    ])
  })
})

describe('parsePorcelainZ', () => {
  it('lists modified and untracked paths and skips a rename origin record', () => {
    expect(parsePorcelainZ(' M a.ts\0?? b.ts\0R  new.ts\0old.ts\0D  gone.ts\0')).toEqual([
      'a.ts',
      'b.ts',
      'new.ts',
      'gone.ts',
    ])
  })
})
