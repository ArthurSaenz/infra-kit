import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeRetiredWarmCacheRoot } from '../init'

let cache: string
let originalXdg: string | undefined

beforeEach(() => {
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-warm-cache-'))
  originalXdg = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = cache
})

afterEach(() => {
  if (originalXdg === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalXdg
  }

  fs.rmSync(cache, { recursive: true, force: true })
})

describe('removeRetiredWarmCacheRoot', () => {
  it('deletes <cacheRoot>/projects with its warm copies and leaves sibling session dirs alone', () => {
    const root = path.join(cache, 'infra-kit')
    const projects = path.join(root, 'projects', 'deadbeef')
    const session = path.join(root, '0123abcd')

    fs.mkdirSync(projects, { recursive: true })
    fs.mkdirSync(session, { recursive: true })
    fs.writeFileSync(path.join(projects, 'env-load.sh'), "export SECRET='1'\n")
    fs.writeFileSync(path.join(session, 'env-load.sh'), "export FOO='1'\n")

    removeRetiredWarmCacheRoot()

    expect(fs.existsSync(path.join(root, 'projects'))).toBe(false)
    expect(fs.existsSync(path.join(session, 'env-load.sh'))).toBe(true)
  })

  it('is a no-op when the dir is absent', () => {
    expect(fs.existsSync(path.join(cache, 'infra-kit'))).toBe(false)

    expect(() => {
      removeRetiredWarmCacheRoot()
    }).not.toThrow()

    expect(fs.existsSync(path.join(cache, 'infra-kit'))).toBe(false)
  })
})
