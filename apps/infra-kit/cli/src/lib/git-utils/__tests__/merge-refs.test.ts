import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { $ } from 'zx'

import { isAncestor, lsRemoteHead, pushAtomic, revParseVerify } from '../merge-refs'

/**
 * Real repositories with a real remote. Every claim here is about git's
 * behaviour — that a bad ref exits 128 from `is-ancestor` rather than returning
 * false, that `--atomic` is genuinely all-or-nothing — and a command-string mock
 * would encode our belief about each and keep passing when the belief is wrong.
 */

const tmpRoots: string[] = []

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await $({ cwd, quiet: true })`git ${args}`

  return result.stdout.trim()
}

/** Bare origin + clone, `dev` ahead, and three release branches forked off an older dev. */
const makeFixture = async (): Promise<{ repo: string; origin: string }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-refs-'))

  tmpRoots.push(root)

  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'work')

  await $({ quiet: true })`git init -q --bare ${origin}`
  await $({ quiet: true })`git clone -q ${origin} ${repo}`

  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test')

  await fs.writeFile(path.join(repo, 'a.txt'), 'base\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'base')
  await git(repo, 'branch', '-M', 'dev')
  await git(repo, 'push', '-q', '-u', 'origin', 'dev')

  for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
    await git(repo, 'switch', '-q', 'dev')
    await git(repo, 'switch', '-qc', `release/v${version}`)
    await fs.writeFile(path.join(repo, `r-${version}.txt`), version)
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', `release ${version}`)
    await git(repo, 'push', '-q', '-u', 'origin', `release/v${version}`)
  }

  // Move dev forward so the release branches are strictly behind it.
  await git(repo, 'switch', '-q', 'dev')
  await fs.writeFile(path.join(repo, 'b.txt'), 'dev work\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'dev work')
  await git(repo, 'push', '-q', 'origin', 'dev')
  await git(repo, 'fetch', '-q', 'origin')

  return { repo, origin }
}

afterAll(async () => {
  await Promise.all(
    tmpRoots.map((root) => {
      return fs.rm(root, { recursive: true, force: true })
    }),
  )
})

describe('revParseVerify', () => {
  it('resolves an existing ref and returns null for a missing one', async () => {
    const { repo } = await makeFixture()

    expect(await revParseVerify(repo, 'origin/dev')).toMatch(/^[0-9a-f]{40}$/)
    expect(await revParseVerify(repo, 'origin/release/v9.9.9')).toBeNull()
  })
})

describe('isAncestor', () => {
  it('reports containment both ways', async () => {
    const { repo } = await makeFixture()

    // A release branch forked off an older dev: dev is NOT yet contained in it.
    expect(await isAncestor(repo, 'origin/dev', 'origin/release/v1.0.0')).toBe(false)

    // After the merge lands, it is — this is the idempotency probe.
    await git(repo, 'switch', '-q', 'release/v1.0.0')
    await git(repo, 'merge', 'origin/dev', '--no-edit', '-q')
    await git(repo, 'push', '-q', 'origin', 'release/v1.0.0')
    await git(repo, 'fetch', '-q', 'origin')

    expect(await isAncestor(repo, 'origin/dev', 'origin/release/v1.0.0')).toBe(true)
  })

  it('tHROWS on an unknown ref rather than reporting "not contained"', async () => {
    const { repo } = await makeFixture()

    // git exits 128 here, not 1. Flattening that to `false` would make the
    // command re-merge a branch it had already finished, so the distinction is
    // load-bearing rather than pedantic.
    await expect(isAncestor(repo, 'origin/dev', 'origin/release/v9.9.9')).rejects.toBeDefined()
  })
})

describe('pushAtomic', () => {
  it('advances every branch in one push', async () => {
    const { repo } = await makeFixture()

    const refs = []

    for (const version of ['1.0.0', '1.1.0']) {
      const branch = `release/v${version}`

      await git(repo, 'switch', '-q', branch)
      await git(repo, 'merge', 'origin/dev', '--no-edit', '-q')
      refs.push({ branch, sha: await git(repo, 'rev-parse', 'HEAD') })
    }

    const result = await pushAtomic(repo, refs)

    expect(result.pushed).toBe(true)
    expect(result.refspecs).toHaveLength(2)

    await git(repo, 'fetch', '-q', 'origin')
    for (const ref of refs) {
      expect(await git(repo, 'rev-parse', `origin/${ref.branch}`)).toBe(ref.sha)
    }
  })

  it('leaves ALL refs unchanged when one of them is not fast-forwardable', async () => {
    const { repo } = await makeFixture()

    // A teammate pushes to release/v1.2.0 from a second clone, so our planned sha
    // for it is stale while the other two are still perfectly pushable.
    const other = path.join(path.dirname(repo), 'teammate')

    await $({ quiet: true })`git clone -q ${path.join(path.dirname(repo), 'origin.git')} ${other}`
    await git(other, 'config', 'user.email', 'mate@example.com')
    await git(other, 'config', 'user.name', 'Mate')
    await git(other, 'switch', '-q', 'release/v1.2.0')
    await fs.writeFile(path.join(other, 'mate.txt'), 'theirs\n')
    await git(other, 'add', '.')
    await git(other, 'commit', '-qm', 'teammate work')
    await git(other, 'push', '-q', 'origin', 'release/v1.2.0')

    const theirSha = await git(other, 'rev-parse', 'HEAD')

    const refs = []

    for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
      const branch = `release/v${version}`

      await git(repo, 'switch', '-q', branch)
      await git(repo, 'merge', 'origin/dev', '--no-edit', '-q')
      refs.push({ branch, sha: await git(repo, 'rev-parse', 'HEAD') })
    }

    const before = await Promise.all(
      refs.map((ref) => {
        return lsRemoteHead(repo, ref.branch)
      }),
    )

    const result = await pushAtomic(repo, refs)

    expect(result.pushed).toBe(false)

    // The whole point: the two pushable branches did NOT land. A per-branch loop
    // would have advanced them and left the operator reconstructing which by hand.
    const after = await Promise.all(
      refs.map((ref) => {
        return lsRemoteHead(repo, ref.branch)
      }),
    )

    expect(after).toEqual(before)
    expect(await lsRemoteHead(repo, 'release/v1.2.0')).toBe(theirSha)
  })

  it('never emits a force flag or a + refspec', async () => {
    const { repo } = await makeFixture()

    const result = await pushAtomic(repo, [{ branch: 'release/v1.0.0', sha: await git(repo, 'rev-parse', 'HEAD') }])

    for (const refspec of result.refspecs) {
      expect(refspec.startsWith('+')).toBe(false)
    }
  })

  it('is a no-op with nothing to push', async () => {
    const { repo } = await makeFixture()

    expect(await pushAtomic(repo, [])).toEqual({ refspecs: [], pushed: false })
  })
})
