import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

import { rerunArgv, setParsedArgv } from '../parsed-argv'

describe('rerunArgv', () => {
  const originalCwd = process.cwd()

  afterEach(() => {
    process.chdir(originalCwd)
  })

  it('is the captured user args plus --yes at the end', () => {
    setParsedArgv(['node', 'infra-kit', 'release', 'remove', '1.2.3', '--agent', '--json'])

    expect(rerunArgv()).toEqual(['release', 'remove', '1.2.3', '--agent', '--json', '--yes'])
  })

  it('slices the interactive-menu re-entry argv, which process.argv never carries', () => {
    // `entry/cli.ts` hands `['node', 'infra-kit', ...selected.split(' ')]` to `parseAsync`.
    const argv = ['node', 'infra-kit', 'worktrees', 'list']

    setParsedArgv(argv)
    argv.push('--force')

    expect(rerunArgv()).toEqual(['worktrees', 'list', '--yes'])
  })

  it('makes a relative -C absolute against the cwd the argv was captured in, not the cwd at call time', () => {
    const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'ik-rerun-')))

    try {
      process.chdir(tmp)
      setParsedArgv(['node', 'infra-kit', '-C', 'app', 'release', 'remove', '1.2.3'])
      // What preAction's chdir does before any command runs.
      process.chdir(originalCwd)

      expect(rerunArgv()).toEqual(['-C', path.join(tmp, 'app'), 'release', 'remove', '1.2.3', '--yes'])
    } finally {
      process.chdir(originalCwd)
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('handles the attached -Cdir spelling and leaves an absolute -C alone', () => {
    setParsedArgv(['node', 'infra-kit', '-Capp', 'version'])

    expect(rerunArgv()).toEqual([`-C${path.join(process.cwd(), 'app')}`, 'version', '--yes'])

    setParsedArgv(['node', 'infra-kit', '-C', '/abs/dir', 'version'])

    expect(rerunArgv()).toEqual(['-C', '/abs/dir', 'version', '--yes'])
  })

  it('does not append a second --yes (or -y) when the argv already carries one', () => {
    setParsedArgv(['node', 'infra-kit', 'worktrees', 'sync', '--yes'])

    expect(rerunArgv()).toEqual(['worktrees', 'sync', '--yes'])

    setParsedArgv(['node', 'infra-kit', 'worktrees', 'sync', '-y'])

    expect(rerunArgv()).toEqual(['worktrees', 'sync', '-y'])
  })
})
