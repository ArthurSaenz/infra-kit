import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { importFromApp } from '../import-from-app'

let root: string

/** `out/apps/web` with a workspace package linked into its node_modules, the way pnpm installs the pruned tree. */
const layOutPrunedApp = async () => {
  const packageDir = path.join(root, 'out', 'vendor', 'packages', 'site-index')
  const appDir = path.join(root, 'out', 'apps', 'web')

  await fs.mkdir(path.join(packageDir, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@wl/site-index', type: 'module', exports: { './deploy': { import: './src/deploy.mjs' } } }),
  )
  await fs.writeFile(path.join(packageDir, 'src', 'deploy.mjs'), 'export const publish = () => "published"\n')
  await fs.mkdir(path.join(appDir, 'node_modules', '@wl'), { recursive: true })
  await fs.symlink(packageDir, path.join(appDir, 'node_modules', '@wl', 'site-index'), 'dir')

  return appDir
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'import-from-app-')))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('importFromApp', () => {
  it("resolves a package through the app's node_modules and the package's exports map", async () => {
    const appDir = await layOutPrunedApp()

    const module = await importFromApp<{ publish: () => string }>(appDir, '@wl/site-index/deploy')

    expect(module.publish()).toBe('published')
  })

  it('leaves nothing behind in appDir', async () => {
    const appDir = await layOutPrunedApp()

    await importFromApp(appDir, '@wl/site-index/deploy')

    expect(await fs.readdir(appDir)).toEqual(['node_modules'])
  })

  it('rejects for an app whose tree does not have the package, and still cleans up', async () => {
    const appDir = path.join(root, 'apps', 'web')

    await fs.mkdir(appDir, { recursive: true })

    await expect(importFromApp(appDir, '@wl/site-index/deploy')).rejects.toThrow(/Cannot find package/)
    expect(await fs.readdir(appDir)).toEqual([])
  })
})
