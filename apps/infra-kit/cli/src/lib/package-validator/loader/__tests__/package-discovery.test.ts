import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { partitionPackages } from '../package-discovery'

let root: string

const addPackage = (rel: string): string => {
  const dir = path.join(root, rel)

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir) }))

  return dir
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-discovery-'))
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*/ui\n  - apps/*/ui/pages/*\n')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('partitionPackages', () => {
  it('moves the packages an exclude glob matches into `excluded`', async () => {
    const ui = addPackage('apps/special/ui')
    const page = addPackage('apps/special/ui/pages/xmas')

    expect(await partitionPackages(root, ['apps/special/ui/pages/*'])).toEqual({ packages: [ui], excluded: [page] })
  })

  it('accepts a trailing slash and a literal path', async () => {
    const ui = addPackage('apps/special/ui')
    const page = addPackage('apps/special/ui/pages/xmas')

    expect(await partitionPackages(root, ['apps/special/ui/'])).toEqual({ packages: [page], excluded: [ui] })
  })

  it('excludes nothing without globs, or when a glob matches no package', async () => {
    const ui = addPackage('apps/special/ui')

    expect(await partitionPackages(root, [])).toEqual({ packages: [ui], excluded: [] })
    expect(await partitionPackages(root, ['apps/missing/*'])).toEqual({ packages: [ui], excluded: [] })
  })
})
