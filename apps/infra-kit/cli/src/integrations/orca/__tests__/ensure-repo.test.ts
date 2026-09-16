import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { addOrcaRepo, findOrcaRepo } from '../ensure-repo'
import { ok, orcaCli, routes } from './orca-cli-mock'

vi.mock('zx', async () => {
  return (await import('./orca-cli-mock')).zxModule
})

const scratch = mkdtempSync(join(tmpdir(), 'orca-ensure-repo-'))
const realRepo = join(scratch, 'repo')
const linkedRepo = join(scratch, 'repo-link')

mkdirSync(realRepo)
symlinkSync(realRepo, linkedRepo)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('findOrcaRepo', () => {
  beforeEach(() => {
    orcaCli.reset()
  })

  it('matches a registered repo through a symlink and reports its visibility', async () => {
    orcaCli.respond = routes({
      'repo list': ok({ repos: [{ path: realpathSync(realRepo), externalWorktreeVisibility: 'hide' }] }),
    })

    await expect(findOrcaRepo(linkedRepo)).resolves.toEqual({ registered: true, visibility: 'hide' })
    expect(orcaCli.calls).toEqual([['repo', 'list']])
  })

  it('reports an unregistered repo without visibility', async () => {
    orcaCli.respond = routes({ 'repo list': ok({ repos: [{ path: '/home/dev/other' }] }) })

    await expect(findOrcaRepo(realRepo)).resolves.toEqual({ registered: false })
  })
})

describe('addOrcaRepo', () => {
  beforeEach(() => {
    orcaCli.reset()
  })

  it('passes --path and returns the visibility of the new row', async () => {
    orcaCli.respond = routes({
      'repo add': ok({ repo: { id: 'r1', path: realRepo, externalWorktreeVisibility: 'hide' } }),
    })

    await expect(addOrcaRepo(realRepo)).resolves.toEqual({ visibility: 'hide' })
    expect(orcaCli.calls).toEqual([['repo', 'add', '--path', realRepo]])
  })
})
