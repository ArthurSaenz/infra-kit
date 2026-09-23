import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { commitAll, git, isolateGitEnv, writeFile } from 'src/lib/vendor/sync/__tests__/sync-fixture'

import { preflightSource } from '../source-preflight'

let restoreEnv: () => void
let tmp: string
let source: string

const initSource = (): void => {
  fs.mkdirSync(source, { recursive: true })
  git(source, ['init', '-q', '-b', 'main'])
  git(source, ['config', 'user.name', 'Fixture'])
  git(source, ['config', 'user.email', 'fixture@example.com'])
  git(source, ['config', 'commit.gpgsign', 'false'])
  writeFile(source, 'README.md', '# source\n')
  commitAll(source, 'source: initial')
}

const addOrigin = (): void => {
  const bare = path.join(tmp, 'origin.git')

  git(tmp, ['init', '-q', '--bare', '-b', 'main', bare])
  git(source, ['remote', 'add', 'origin', bare])
  git(source, ['push', '-q', 'origin', 'main'])
  git(source, ['remote', 'set-head', 'origin', 'main'])
}

const refusal = async (): Promise<StructuredRefusalError> => {
  const error: unknown = await preflightSource(source).catch((caught: unknown) => {
    return caught
  })

  expect(error).toBeInstanceOf(StructuredRefusalError)

  return error as StructuredRefusalError
}

beforeAll(() => {
  restoreEnv = isolateGitEnv()
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-sync-preflight-'))
  source = path.join(tmp, 'source')
  initSource()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

afterAll(() => {
  restoreEnv()
})

describe('preflightSource — real git', () => {
  it('refuses an untracked file with source-dirty, naming the path', async () => {
    writeFile(source, 'notes/draft.md', 'wip\n')

    const error = await refusal()

    expect(error.structuredContent).toEqual({ status: 'refused', reason: 'source-dirty', paths: ['notes/'] })
    expect(error.exitCode).toBe(1)
    expect(error.remediation).toContain('notes/')
  })

  it('refuses a modified tracked file', async () => {
    writeFile(source, 'README.md', '# edited\n')

    expect((await refusal()).structuredContent).toMatchObject({ reason: 'source-dirty', paths: ['README.md'] })
  })

  it('passes a clean tree and warns twice when there is no origin', async () => {
    const rows = await preflightSource(source)

    expect(rows[0]).toEqual({ name: 'working tree', status: 'ok', message: 'clean' })
    expect(rows.slice(1)).toMatchObject([
      { name: 'HEAD pushed', status: 'warn' },
      { name: 'default branch', status: 'warn', message: expect.stringContaining('origin/HEAD') },
    ])
  })

  it('warns about nothing when HEAD is the pushed default branch', async () => {
    addOrigin()

    expect(await preflightSource(source)).toEqual([{ name: 'working tree', status: 'ok', message: 'clean' }])
  })

  it('warns about an unpushed HEAD on a side branch', async () => {
    addOrigin()
    git(source, ['switch', '-q', '-c', 'feature'])
    writeFile(source, 'feature.md', 'new\n')
    commitAll(source, 'source: unpushed')

    const rows = await preflightSource(source)

    expect(rows.slice(1)).toMatchObject([
      { name: 'HEAD pushed', status: 'warn' },
      { name: 'default branch', status: 'warn', message: expect.stringContaining('syncing from feature') },
    ])
  })
})
