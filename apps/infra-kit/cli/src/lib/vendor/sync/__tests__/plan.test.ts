import { describe, expect, it } from 'vitest'

import { buildTargetPlan, diffEntry, isVendoredTarget, recoveryArgv, resolveCopyEntry } from 'src/lib/vendor/sync'
import type { SourceFacts, TargetFacts } from 'src/lib/vendor/sync'

import type { Fingerprint, SourceEntryFacts, SourceFile, TargetEntryFacts } from '../types'

const file = (sha: string): Fingerprint => {
  return { kind: 'file', executable: false, sha }
}

const sourceFile = (filePath: string, sha: string): SourceFile => {
  return { path: filePath, mode: '100644', fingerprint: file(sha) }
}

const sourceEntry = (entryPath: string, files: SourceFile[]): SourceEntryFacts => {
  return { entry: resolveCopyEntry({ path: entryPath }), files }
}

const source = (entries: SourceEntryFacts[], overrides: Partial<SourceFacts> = {}): SourceFacts => {
  return {
    root: '/ws/starter',
    selfRoots: ['/ws/starter'],
    name: 'starter',
    headSha: 'f00dfacecafe',
    entries,
    exclude: [],
    legacyCleanup: [],
    ...overrides,
  }
}

type RepoFacts = Extract<TargetFacts, { kind: 'repo' }>

const repo = (entries: TargetEntryFacts[], overrides: Partial<RepoFacts> = {}): TargetFacts => {
  return {
    name: 'app',
    root: '/ws/app',
    kind: 'repo',
    branch: 'main',
    dirty: [],
    entries,
    legacy: [],
    headVendorMeta: [],
    readmeCurrent: true,
    manifestPresent: true,
    changelog: { kind: 'log', sha: 'abc1234def', lines: ['abc1234 tweak'] },
    ...overrides,
  }
}

describe('buildTargetPlan — row status', () => {
  const claude = sourceEntry('.claude', [sourceFile('.claude/a.md', 'A')])

  it('skips a target that is not checked out', () => {
    const plan = buildTargetPlan(source([claude]), { name: 'app', root: '/ws/app', kind: 'missing' })

    expect(plan.status).toBe('skipped')
    expect(plan.message).toContain('/ws/app')
  })

  it('skips the source repo itself', () => {
    expect(buildTargetPlan(source([claude]), { name: 'starter', root: '/ws/starter', kind: 'source' }).status).toBe(
      'skipped',
    )
  })

  it('fails a target that is not a git repo', () => {
    const facts: TargetFacts = { name: 'app', root: '/ws/app', kind: 'not-git', reason: 'fatal: not a git repository' }

    expect(buildTargetPlan(source([claude]), facts).status).toBe('fail')
  })

  it('blocks a dirty tracked path and names it plus the git status argv', () => {
    const plan = buildTargetPlan(
      source([claude], { legacyCleanup: ['configs'] }),
      repo([{ target: '.claude', tracked: ['.claude/a.md'], onDisk: { '.claude/a.md': file('edited') } }], {
        dirty: ['.claude/a.md'],
      }),
    )

    expect(plan.status).toBe('fail')
    expect(plan.notes).toContain('.claude/a.md')
    expect(plan.notes.at(-1)).toBe('git -C /ws/app --literal-pathspecs status -- .claude configs')
    expect(plan.recoveryPaths).toEqual([])
  })

  it('is ok when the diff is empty', () => {
    const plan = buildTargetPlan(
      source([claude]),
      repo([{ target: '.claude', tracked: ['.claude/a.md'], onDisk: { '.claude/a.md': file('A') } }]),
    )

    expect(plan.status).toBe('ok')
    expect(plan.warnings).toEqual([])
  })

  it('counts added, modified and removed files per entry', () => {
    const entry = sourceEntry('.claude', [
      sourceFile('.claude/same.md', 'S'),
      sourceFile('.claude/changed.md', 'new'),
      sourceFile('.claude/new.md', 'N'),
    ])
    const plan = buildTargetPlan(
      source([entry]),
      repo([
        {
          target: '.claude',
          tracked: ['.claude/same.md', '.claude/changed.md', '.claude/stale.md'],
          onDisk: { '.claude/same.md': file('S'), '.claude/changed.md': file('old'), '.claude/new.md': null },
        },
      ]),
    )

    expect(plan.status).toBe('changed')
    expect(plan.entries[0]?.counts).toEqual({ added: 1, modified: 1, removed: 1 })
    expect(plan.message).toBe('1 added, 1 modified, 1 removed on main')
    expect(plan.notes).toContain('1 starter commit(s) since abc1234')
    expect(plan.recoveryPaths).toEqual(['.claude/changed.md', '.claude/stale.md'])
    expect(recoveryArgv(plan)).toEqual([
      'git',
      '-C',
      '/ws/app',
      '--literal-pathspecs',
      'checkout',
      'HEAD',
      '--',
      '.claude/changed.md',
      '.claude/stale.md',
    ])
  })

  it('warns instead of listing commits when the manifest sha is unknown', () => {
    const plan = buildTargetPlan(
      source([claude]),
      repo([{ target: '.claude', tracked: [], onDisk: { '.claude/a.md': null } }], {
        changelog: { kind: 'unknown-sha' },
      }),
    )

    expect(plan.status).toBe('changed')
    expect(plan.warnings).toHaveLength(1)
  })

  it('treats a mode change or a link where a file was as a modification', () => {
    const entry = sourceEntry('bin', [
      { path: 'bin/run', mode: '100755', fingerprint: { kind: 'file', executable: true, sha: 'R' } },
      { path: 'bin/link', mode: '120000', fingerprint: { kind: 'link', text: '../x' } },
    ])
    const plan = diffEntry(
      entry,
      { target: 'bin', tracked: ['bin/run', 'bin/link'], onDisk: { 'bin/run': file('R'), 'bin/link': file('x') } },
      [],
    )

    expect(plan.counts).toEqual({ added: 0, modified: 2, removed: 0 })
  })
})

describe('diffEntry — excludes', () => {
  it('drops an excluded segment from both sides, so a target-only tracked file is never deleted', () => {
    const entry = sourceEntry('vendor/configs', [
      sourceFile('vendor/configs/eslint/index.js', 'E'),
      sourceFile('vendor/configs/serverless-config/source-only.ts', 'S'),
    ])
    const plan = diffEntry(
      entry,
      {
        target: 'vendor/configs',
        tracked: ['vendor/configs/eslint/index.js', 'vendor/configs/serverless-config/consumer.ts'],
        onDisk: { 'vendor/configs/eslint/index.js': file('E') },
      },
      ['serverless-config'],
    )

    expect(plan.deletes).toEqual([])
    expect(plan.writes).toEqual([])
    expect(plan.targetPaths).toEqual(['vendor/configs/eslint/index.js'])
  })
})

describe('vendored inference', () => {
  it('marks entries under vendor/ as vendored and everything else as not', () => {
    expect(isVendoredTarget('vendor/configs')).toBe(true)
    expect(isVendoredTarget('.claude')).toBe(false)
    expect(isVendoredTarget('vendorish/configs')).toBe(false)
    expect(resolveCopyEntry({ path: 'tools/configs', target: 'vendor/configs' }).vendored).toBe(true)
  })

  it('rewrites the README and manifest only when a vendored entry exists', () => {
    const vendored = buildTargetPlan(
      source([sourceEntry('vendor/configs', [sourceFile('vendor/configs/a.js', 'A')])]),
      repo(
        [{ target: 'vendor/configs', tracked: ['vendor/configs/a.js'], onDisk: { 'vendor/configs/a.js': file('A') } }],
        {
          readmeCurrent: false,
        },
      ),
    )
    const plain = buildTargetPlan(
      source([sourceEntry('.claude', [sourceFile('.claude/a.md', 'A')])]),
      repo([{ target: '.claude', tracked: ['.claude/a.md'], onDisk: { '.claude/a.md': file('A') } }], {
        readmeCurrent: false,
      }),
    )

    expect(vendored.status).toBe('changed')
    expect(vendored.writeVendorMeta).toBe(true)
    expect(plain.status).toBe('ok')
    expect(plain.writeVendorMeta).toBe(false)
  })
})
