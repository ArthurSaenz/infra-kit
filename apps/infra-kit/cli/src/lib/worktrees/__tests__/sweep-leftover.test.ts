import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { classifyDirectory, sweepLeftover } from '../sweep-leftover'

const tmpRoots: string[] = []

const makeDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-sweep-'))

  tmpRoots.push(dir)

  return dir
}

afterAll(async () => {
  await Promise.all(
    tmpRoots.map((dir) => {
      return fs.rm(dir, { recursive: true, force: true })
    }),
  )
})

const noSleep = (): Promise<void> => {
  return Promise.resolve()
}

describe('classifyDirectory and sweepLeftover', () => {
  it('removes a directory holding only the hook-recreated allowlist', async () => {
    const dir = await makeDir()

    await fs.mkdir(path.join(dir, '.omc', 'state', 'x'), { recursive: true })
    await fs.writeFile(path.join(dir, '.DS_Store'), '')

    expect((await classifyDirectory(dir)).state).toBe('sweepable-only')
    expect(await sweepLeftover({ worktreePath: dir, sleep: noSleep })).toBe(true)
    await expect(fs.access(dir)).rejects.toThrow()
  })

  it('names notes.txt as an other entry and deletes nothing', async () => {
    const dir = await makeDir()

    await fs.mkdir(path.join(dir, '.omc', 'state'), { recursive: true })
    await fs.writeFile(path.join(dir, 'notes.txt'), 'mine')

    expect(await classifyDirectory(dir)).toEqual({ state: 'has-other-entries', otherEntries: ['notes.txt'] })
    expect(await fs.readFile(path.join(dir, 'notes.txt'), 'utf8')).toBe('mine')
  })

  it('names a committable .omc/skills entry', async () => {
    const dir = await makeDir()

    await fs.mkdir(path.join(dir, '.omc', 'skills'), { recursive: true })

    expect(await classifyDirectory(dir)).toEqual({ state: 'has-other-entries', otherEntries: ['.omc/skills'] })
  })

  it('reports an absent path as absent', async () => {
    const dir = await makeDir()

    expect(await classifyDirectory(path.join(dir, 'missing'))).toEqual({ state: 'absent' })
  })
})
