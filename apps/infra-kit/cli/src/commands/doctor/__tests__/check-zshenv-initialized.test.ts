import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildZshenvBlock } from 'src/commands/init'
import { MARKER_END, MARKER_START } from 'src/commands/init/init'

import { checkZshenvInitialized } from '../doctor'

// Never let a doctor unit test touch the developer's real ~/.zshenv — os.homedir()
// is redirected to a throwaway temp dir for the whole file.
vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

let home: string
let zshenvPath: string

beforeEach(() => {
  vi.clearAllMocks()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-zshenv-'))
  zshenvPath = path.join(home, '.zshenv')
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('checkZshenvInitialized', () => {
  it('passes when the current block is installed verbatim', () => {
    fs.writeFileSync(zshenvPath, `# user zshenv\nexport FOO=1\n${buildZshenvBlock()}\n`)

    const result = checkZshenvInitialized()

    expect(result.status).toBe('pass')
    expect(result.message).toContain('up to date')
  })

  it('fails when ~/.zshenv does not exist', () => {
    const result = checkZshenvInitialized()

    expect(result.status).toBe('fail')
    expect(result.message).toContain('~/.zshenv not found')
  })

  it('fails when the block is absent from an existing ~/.zshenv', () => {
    fs.writeFileSync(zshenvPath, '# just a user zshenv\nexport FOO=1\n')

    const result = checkZshenvInitialized()

    expect(result.status).toBe('fail')
    expect(result.message).toContain('session-env block missing')
  })

  it('treats reversed markers (end before start) as missing, not a match', () => {
    fs.writeFileSync(zshenvPath, `${MARKER_END}\nstray\n${MARKER_START}\n`)

    const result = checkZshenvInitialized()

    expect(result.status).toBe('fail')
    expect(result.message).toContain('session-env block missing')
  })

  it('fails as out-of-date when the installed block has drifted from current', () => {
    const drifted = buildZshenvBlock().replace(MARKER_START, `${MARKER_START}\n# drift`)

    fs.writeFileSync(zshenvPath, `${drifted}\n`)

    const result = checkZshenvInitialized()

    expect(result.status).toBe('fail')
    expect(result.message).toContain('out of date')
  })
})
