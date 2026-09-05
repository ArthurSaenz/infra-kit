import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AdoptionState } from 'src/lib/agent-guidance'

import { checkAgentGuidance } from '../agent-guidance-check'
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

describe('checkAgentGuidance', () => {
  const WORKSPACE_ROOT = path.join(os.tmpdir(), 'guidance-workspace')

  /** A workspace where no package carries a well-formed block. */
  const unadopted: AdoptionState = { adopted: false, workspaceRoot: WORKSPACE_ROOT }

  /** A workspace adopted by `packages/lib-a`, which is NOT the package under test. */
  const adopted: AdoptionState = {
    adopted: true,
    workspaceRoot: WORKSPACE_ROOT,
    evidencePath: path.join(WORKSPACE_ROOT, 'packages/lib-a/CLAUDE.md'),
  }

  const wellFormedBlock = [
    '<!-- infra-kit:package:begin -->',
    '<!-- infra-kit:package:version 0.4.0 frontend -->',
    '# @x/pkg',
    '<!-- infra-kit:package:end -->',
  ].join('\n')

  const rootBlock = [
    '<!-- infra-kit:begin -->',
    '<!-- infra-kit:version 0.4.0 -->',
    'root guidance',
    '<!-- infra-kit:end -->',
  ].join('\n')

  /** A package directory whose `CLAUDE.md` holds `content`, or has no `CLAUDE.md` when null. */
  const packageWithGuidance = (content: string | null): string => {
    const dir = makeTmpDir()

    if (content !== null) {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content)
    }

    return dir
  }

  it('passes an ok block and reports the version and type recorded in it', () => {
    const check = checkAgentGuidance(packageWithGuidance(wellFormedBlock), unadopted)

    expect(check).toEqual({
      name: 'agent-guidance',
      status: 'pass',
      message: 'present (block from infra-kit 0.4.0, type frontend)',
    })
  })

  it('passes an ok block after adoption too', () => {
    const check = checkAgentGuidance(packageWithGuidance(wellFormedBlock), adopted)

    expect(check).toMatchObject({ status: 'pass', message: 'present (block from infra-kit 0.4.0, type frontend)' })
  })

  it('passes a missing CLAUDE.md with the not-yet-adopted advisory before adoption', () => {
    const check = checkAgentGuidance(packageWithGuidance(null), unadopted)

    expect(check).toEqual({
      name: 'agent-guidance',
      status: 'pass',
      message: 'not yet adopted — CLAUDE.md missing — run: infra-kit audit --fix',
    })
  })

  it('fails a missing CLAUDE.md after adoption and names the adopting package', () => {
    const check = checkAgentGuidance(packageWithGuidance(null), adopted)

    expect(check).toEqual({
      name: 'agent-guidance',
      status: 'fail',
      message:
        'CLAUDE.md missing — run: infra-kit audit --fix (workspace adopted: packages/lib-a/CLAUDE.md carries a package block)',
    })
  })

  it('passes a CLAUDE.md with no block before adoption and fails it after', () => {
    const dir = packageWithGuidance('# hand-written guidance\n')
    const expected =
      'CLAUDE.md has no infra-kit block (expected <!-- infra-kit:package:begin --> … <!-- infra-kit:package:end -->) — run: infra-kit audit --fix'

    expect(checkAgentGuidance(dir, unadopted)).toEqual({
      name: 'agent-guidance',
      status: 'pass',
      message: `not yet adopted — ${expected}`,
    })
    expect(checkAgentGuidance(dir, adopted)).toEqual({ name: 'agent-guidance', status: 'fail', message: expected })
  })

  it('passes a malformed block before adoption and fails it after', () => {
    const dir = packageWithGuidance('<!-- infra-kit:package:end -->\nbody\n<!-- infra-kit:package:begin -->\n')
    const expected =
      'CLAUDE.md block is malformed (end marker precedes start, or body is empty) — run: infra-kit audit --fix'

    expect(checkAgentGuidance(dir, unadopted)).toMatchObject({
      status: 'pass',
      message: `not yet adopted — ${expected}`,
    })
    expect(checkAgentGuidance(dir, adopted)).toMatchObject({ status: 'fail', message: expected })
  })

  it('passes a pasted root block before adoption and fails it after', () => {
    const dir = packageWithGuidance(rootBlock)
    const expected =
      'CLAUDE.md carries the ROOT infra-kit block (<!-- infra-kit:begin -->); a package needs the package block — run: infra-kit audit --fix'

    expect(checkAgentGuidance(dir, unadopted)).toMatchObject({
      status: 'pass',
      message: `not yet adopted — ${expected}`,
    })
    expect(checkAgentGuidance(dir, adopted)).toMatchObject({ status: 'fail', message: expected })
  })

  it('appends the adopting evidence only to the missing message', () => {
    const noBlock = checkAgentGuidance(packageWithGuidance('# prose\n'), adopted)

    expect(noBlock.message).not.toContain('workspace adopted:')
  })
})
