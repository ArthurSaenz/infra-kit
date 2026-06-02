import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { checkFiles } from '../files-check'
import { checkScripts } from '../scripts-check'
import { checkTurbo } from '../turbo-check'

const tmpDirs: string[] = []

const makeTmpDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-'))

  tmpDirs.push(dir)

  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()

    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('checkScripts', () => {
  it('passes a script defined with a runnable command', () => {
    const checks = checkScripts({ build: 'tsc' }, ['build'])

    expect(checks).toEqual([{ name: 'script:build', status: 'pass', message: 'defined' }])
  })

  it('fails a script that is absent from the scripts map', () => {
    const checks = checkScripts({}, ['build'])

    expect(checks[0]).toMatchObject({ name: 'script:build', status: 'fail' })
    expect(checks[0]?.message).toContain('missing')
  })

  it('fails a script declared with an empty value', () => {
    const checks = checkScripts({ build: '' }, ['build'])

    expect(checks[0]).toMatchObject({ name: 'script:build', status: 'fail' })
    expect(checks[0]?.message).toContain('empty')
  })

  it('fails a script declared with a whitespace-only value', () => {
    const checks = checkScripts({ build: '   ' }, ['build'])

    expect(checks[0]).toMatchObject({ name: 'script:build', status: 'fail' })
    expect(checks[0]?.message).toContain('empty')
  })
})

describe('checkFiles', () => {
  it('passes a required path that is a regular file', async () => {
    const dir = makeTmpDir()

    fs.writeFileSync(path.join(dir, 'readme.md'), '# hi')

    const checks = await checkFiles(dir, ['readme.md'])

    expect(checks[0]).toMatchObject({ name: 'file:readme.md', status: 'pass' })
  })

  it('fails a required file that does not exist', async () => {
    const dir = makeTmpDir()

    const checks = await checkFiles(dir, ['readme.md'])

    expect(checks[0]).toMatchObject({ name: 'file:readme.md', status: 'fail' })
    expect(checks[0]?.message).toContain('missing file')
  })

  it('fails a required path that exists but is a directory', async () => {
    const dir = makeTmpDir()

    fs.mkdirSync(path.join(dir, 'readme.md'))

    const checks = await checkFiles(dir, ['readme.md'])

    expect(checks[0]).toMatchObject({ name: 'file:readme.md', status: 'fail' })
    expect(checks[0]?.message).toContain('not a file')
  })
})

describe('checkTurbo', () => {
  it('returns no checks when no turbo tasks are required', async () => {
    const dir = makeTmpDir()

    expect(await checkTurbo(dir, [])).toEqual([])
  })

  it('fails with a single diagnostic when turbo.json cannot be read', async () => {
    const dir = makeTmpDir()

    const checks = await checkTurbo(dir, ['build'])

    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ name: 'turbo.json', status: 'fail' })
    expect(checks[0]?.message).toContain('cannot read/parse')
  })

  it('fails with a single diagnostic when turbo.json has no tasks object', async () => {
    const dir = makeTmpDir()

    fs.writeFileSync(path.join(dir, 'turbo.json'), JSON.stringify({ $schema: 'x' }))

    const checks = await checkTurbo(dir, ['build', 'test'])

    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ name: 'turbo.json', status: 'fail' })
    expect(checks[0]?.message).toContain('no "tasks" object')
  })

  it('reports per-task results when a tasks object exists', async () => {
    const dir = makeTmpDir()

    fs.writeFileSync(path.join(dir, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }))

    const checks = await checkTurbo(dir, ['build', 'test'])

    expect(checks).toContainEqual(expect.objectContaining({ name: 'turbo:build', status: 'pass' }))
    expect(checks).toContainEqual(expect.objectContaining({ name: 'turbo:test', status: 'fail' }))
  })
})
