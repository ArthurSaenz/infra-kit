import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MARKER_END, MARKER_START, buildShellBlock } from 'src/commands/init/init'

import { checkZshrcInitialized } from '../doctor'

// Never let a doctor unit test touch the developer's real ~/.zshrc — os.homedir()
// is redirected to a throwaway temp dir for the whole file.
vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

let home: string
let zshrcPath: string

beforeEach(() => {
  vi.clearAllMocks()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-zshrc-'))
  zshrcPath = path.join(home, '.zshrc')
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('checkZshrcInitialized', () => {
  it('passes when the current block is installed verbatim', () => {
    fs.writeFileSync(zshrcPath, `# user rc\nexport FOO=1\n${buildShellBlock()}\n`)

    const result = checkZshrcInitialized()

    expect(result.status).toBe('pass')
    expect(result.message).toContain('up to date')
  })

  it('fails when ~/.zshrc does not exist', () => {
    const result = checkZshrcInitialized()

    expect(result.status).toBe('fail')
    expect(result.message).toContain('~/.zshrc not found')
  })

  it('fails when the block is absent from an existing ~/.zshrc', () => {
    fs.writeFileSync(zshrcPath, '# just a user rc\nexport FOO=1\n')

    const result = checkZshrcInitialized()

    expect(result.status).toBe('fail')
    expect(result.message).toContain('shell block missing')
  })

  it('treats reversed markers (end before start) as missing, not a match', () => {
    fs.writeFileSync(zshrcPath, `${MARKER_END}\nstray\n${MARKER_START}\n`)

    const result = checkZshrcInitialized()

    expect(result.status).toBe('fail')
    expect(result.message).toContain('shell block missing')
  })

  it('fails as out-of-date when the installed block has drifted from current', () => {
    const drifted = buildShellBlock().replace('zmodload zsh/stat', 'zmodload zsh/OLD')

    fs.writeFileSync(zshrcPath, `${drifted}\n`)

    const result = checkZshrcInitialized()

    expect(result.status).toBe('fail')
    expect(result.message).toContain('out of date')
  })
})
