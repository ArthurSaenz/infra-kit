import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readDevContext } from '../dev-context'

const tmpDirs: string[] = []

/** A throwaway repo root with a `.git` anchor, cleaned up after each test. */
const makeRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-devctx-'))

  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  tmpDirs.push(dir)

  return fs.realpathSync(dir)
}

/** Write a dev-context fragment for `app` under the repo's `.infra-kit/dev-context`. */
const writeFragment = (repo: string, app: string, fragment: Record<string, unknown>): string => {
  const fragmentDir = path.join(repo, '.infra-kit', 'dev-context')

  fs.mkdirSync(fragmentDir, { recursive: true })
  const file = path.join(fragmentDir, `${app}.json`)

  fs.writeFileSync(file, JSON.stringify(fragment, null, 2))

  return file
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

describe('readDevContext', () => {
  it('resolves to an empty, non-error snapshot when no dev session has written a fragment', () => {
    const repo = makeRepo()

    const snapshot = readDevContext(repo)

    expect(snapshot.session).toBe('none')
    expect(snapshot.apps).toEqual([])
    // Not an error: a repo with no `.infra-kit` still reads cleanly.
    expect(typeof snapshot.readAt).toBe('number')
  })

  it('reads and normalizes the fragments a running dev session wrote, sorted by app', () => {
    const repo = makeRepo()

    writeFragment(repo, 'backend', {
      v: 3,
      package: '@acme/backend',
      port: 4001,
      pid: 12345,
      writtenAt: 1700000000000,
      release: 'my-branch',
      alias: 'backend.acme.localhost',
      origin: 'http://127.0.0.1:4001',
    })
    writeFragment(repo, 'admin', {
      v: 3,
      package: '@acme/admin',
      port: 4002,
      alias: 'admin.acme.localhost',
      origin: 'http://127.0.0.1:4002',
    })

    const snapshot = readDevContext(repo)

    expect(snapshot.session).toBe('active')
    expect(
      snapshot.apps.map((a) => {
        return a.app
      }),
    ).toEqual(['admin', 'backend'])
    const backend = snapshot.apps.find((a) => {
      return a.app === 'backend'
    })!

    expect(backend.package).toBe('@acme/backend')
    expect(backend.port).toBe(4001)
    expect(backend.origin).toBe('http://127.0.0.1:4001')
    expect(backend.mtimeMs).toBeGreaterThan(0)
    expect(backend.ageMs).toBeGreaterThanOrEqual(0)
  })

  it('finds the fragment dir up-tree from a nested package cwd', () => {
    const repo = makeRepo()

    writeFragment(repo, 'backend', {
      v: 3,
      package: '@acme/backend',
      port: 4001,
      alias: 'a',
      origin: 'http://127.0.0.1:4001',
    })
    const nested = path.join(repo, 'apps', 'admin')

    fs.mkdirSync(nested, { recursive: true })

    const snapshot = readDevContext(nested)

    expect(snapshot.session).toBe('active')
    expect(snapshot.apps).toHaveLength(1)
  })

  it('reports fragment age from mtime so a consumer can judge staleness', () => {
    const repo = makeRepo()
    const file = writeFragment(repo, 'backend', { v: 3, package: '@acme/backend', port: 4001, alias: 'a', origin: 'o' })
    const old = Date.now() / 1000 - 3600

    fs.utimesSync(file, old, old)

    const snapshot = readDevContext(repo)

    expect(snapshot.apps[0]!.ageMs).toBeGreaterThan(60 * 60 * 1000 - 5000)
  })

  it('skips an unreadable (non-JSON) fragment instead of throwing', () => {
    const repo = makeRepo()
    const fragmentDir = path.join(repo, '.infra-kit', 'dev-context')

    fs.mkdirSync(fragmentDir, { recursive: true })
    fs.writeFileSync(path.join(fragmentDir, 'broken.json'), '{ not json')
    writeFragment(repo, 'good', { v: 3, package: '@acme/good', port: 5000, alias: 'a', origin: 'o' })

    const snapshot = readDevContext(repo)

    expect(
      snapshot.apps.map((a) => {
        return a.app
      }),
    ).toEqual(['good'])
  })
})
