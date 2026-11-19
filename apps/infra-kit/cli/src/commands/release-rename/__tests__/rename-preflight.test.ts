import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { STEP_ORDER } from '../rename-classifier'
import type { RenamePlaces } from '../rename-classifier'
import { formatPlaceTable, isPathInside, liveDevServerPorts, parseRenameRefs } from '../rename-preflight'

describe('parseRenameRefs', () => {
  it('accepts every transition kind', () => {
    expect(parseRenameRefs('1.2.3', '1.3.0').newId).toMatchObject({ kind: 'version', raw: '1.3.0' })
    expect(parseRenameRefs('v1.2.3', 'checkout-redesign').newId).toMatchObject({ kind: 'name' })
    expect(parseRenameRefs('checkout-redesign', '2.0.0').oldId).toMatchObject({ kind: 'name' })
    expect(parseRenameRefs('release/checkout-a', 'checkout-b').oldId).toMatchObject({ name: 'checkout-a' })
  })

  it('refuses next, an invalid name and old === new', () => {
    expect(() => {
      return parseRenameRefs('1.2.3', 'next')
    }).toThrow('"next" is not accepted as <new>')
    expect(() => {
      return parseRenameRefs('1.2.3', 'Not_Kebab')
    }).toThrow('not kebab-case')
    expect(() => {
      return parseRenameRefs('1.2.3', 'main')
    }).toThrow('reserved')
    expect(() => {
      return parseRenameRefs('1.2.3', 'v1.2.3')
    }).toThrow('<old> and <new> both name 1.2.3')
  })
})

describe('formatPlaceTable', () => {
  it('prints one row per place with its reason', () => {
    const places = Object.fromEntries(
      STEP_ORDER.map((step) => {
        return [step, { state: 'pending' }]
      }),
    ) as RenamePlaces

    places['remote-push'] = { state: 'conflict', reason: 'release/x is taken' }
    places.worktree = { state: 'vacuous' }

    const table = formatPlaceTable(places)

    expect(table).toContain('  remote-push: conflict — release/x is taken')
    expect(table).toContain('  worktree: absent')
    expect(table.split('\n')).toHaveLength(STEP_ORDER.length)
  })
})

describe('filesystem predicates', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-preflight-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('isPathInside compares realpaths on both sides', async () => {
    const real = path.join(root, 'real', 'wt')
    const link = path.join(root, 'link')

    await fs.mkdir(path.join(real, 'sub'), { recursive: true })
    await fs.symlink(path.join(root, 'real'), link)

    expect(await isPathInside(path.join(link, 'wt', 'sub'), real)).toBe(true)
    expect(await isPathInside(real, path.join(link, 'wt'))).toBe(true)
    expect(await isPathInside(path.join(root, 'real'), real)).toBe(false)
    expect(await isPathInside(`${real}-sibling`, real)).toBe(false)
  })

  const writeFragment = async (dir: string, port: number): Promise<void> => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'api.json'), JSON.stringify({ port, pid: 1 }))
  }

  it('counts only listening fragments in the worktree own dev-context dir', async () => {
    const worktree = path.join(root, 'wt')

    await writeFragment(path.join(worktree, '.infra-kit', 'dev-context'), 4100)

    expect(
      await liveDevServerPorts(worktree, async (port) => {
        return port === 4100
      }),
    ).toEqual([4100])
    expect(
      await liveDevServerPorts(worktree, async () => {
        return false
      }),
    ).toEqual([])
  })

  it('ignores a fragment dir found up-tree', async () => {
    const worktree = path.join(root, 'wt')

    await fs.mkdir(worktree, { recursive: true })
    await writeFragment(path.join(root, '.infra-kit', 'dev-context'), 4100)

    expect(
      await liveDevServerPorts(worktree, async () => {
        return true
      }),
    ).toEqual([])
  })
})
