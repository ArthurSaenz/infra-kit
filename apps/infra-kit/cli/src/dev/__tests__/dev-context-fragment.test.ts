import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DevServerRunner } from 'src/dev/dev-server'
import { DEFAULT_PORT } from 'src/dev/ports'
import { readLocalContext, readLocalSet } from 'src/lib/vite/vite'

import { createTempTracker, makeMonorepo, restoreCwd, restoreEnv, snapshotCwd, snapshotEnv } from './fixtures'

/**
 * Story 2 — the dev-context fragment WRITE side. Each runner writes its own
 * `.infra-kit/dev-context/<app>.json` recording the ACTUAL bound port, atomically
 * (temp-then-rename), refreshed on restart, and removed on shutdown. The story-3 read
 * side (`readLocalSet`/`readLocalContext`) must agree with what the writer records.
 */
const temp = createTempTracker()
let envSnapshot: NodeJS.ProcessEnv
let cwdSnapshot: string

beforeEach(() => {
  envSnapshot = snapshotEnv()
  cwdSnapshot = snapshotCwd()
})

afterEach(() => {
  restoreCwd(cwdSnapshot)
  restoreEnv(envSnapshot)
  temp.cleanup()
})

/** A no-op build seam: the fixtures already write `dist/handler.js` (withHandler). */
const noopBuild = async (): Promise<void> => {}

/** The dev-context fragment directory for a runner rooted at the current cwd. */
const contextDir = (): string => {
  return path.join(process.cwd(), '.infra-kit', 'dev-context')
}

interface FragmentShape {
  package: string
  port: number
  pid: number
  writtenAt: number
  release?: string
}

/** Read + parse the `<app>.json` fragment (fails the test if it is not valid JSON). */
const readFragment = (appName: string): FragmentShape => {
  return JSON.parse(fs.readFileSync(path.join(contextDir(), `${appName}.json`), 'utf-8')) as FragmentShape
}

/**
 * Initialise a git repo on `branch` with one empty commit so the writer's
 * `git rev-parse --abbrev-ref HEAD` resolves the branch (an unborn branch has no HEAD),
 * and records a real `release` slug.
 */
/* eslint-disable sonarjs/no-os-command-from-path -- hermetic test fixture drives the real `git` CLI */
const gitInit = (dir: string, branch: string): void => {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dir },
  )
}
/* eslint-enable sonarjs/no-os-command-from-path */

/** Minimal structural view of the runner internals a restart test needs. */
interface RunnerInternals {
  appServers: Array<{ app: unknown; boundPort: number }>
  restart: (apps: unknown[]) => Promise<void>
}

describe('dev-context fragment — T1: records the ACTUAL bound ephemeral port', () => {
  it('writes port === the real listen(0) port (∉ {DEFAULT_PORT, 0}) plus package/pid/release', async () => {
    const root = temp.register(makeMonorepo([{ name: 'solo', packageName: 'solo-api', withHandler: true }]))

    gitInit(root, 'feature/story-two')

    // No {APP}_PORT / PORT / dev.<app>.port => the app binds an ephemeral listen(0) port.
    delete process.env.PORT
    delete process.env.SOLO_PORT
    process.chdir(root)

    const runner = new DevServerRunner({}, noopBuild)

    await runner.start()

    try {
      const fragment = readFragment('solo')

      // The recorded port is the REAL ephemeral port — proven by /__health serving on it.
      expect(fragment.port).not.toBe(DEFAULT_PORT)
      expect(fragment.port).not.toBe(0)

      const health = (await (await fetch(`http://127.0.0.1:${fragment.port}/__health`)).json()) as {
        app: string
        port: number
      }

      expect(health).toMatchObject({ app: 'solo', port: fragment.port })

      // package feeds readLocalSet; pid stamps the writer; release is the git-derived slug.
      expect(fragment.package).toBe('solo-api')
      expect(fragment.pid).toBe(process.pid)
      expect(fragment.release).toBe('story-two')

      // No temp file is left behind (atomic temp-then-rename).
      const leftovers = fs.readdirSync(contextDir()).filter((f) => {
        return f.endsWith('.tmp')
      })

      expect(leftovers).toEqual([])

      // End-to-end: the read side agrees with what the writer recorded.
      expect(readLocalSet(process.cwd()).has('solo-api')).toBe(true)
      expect(readLocalContext(process.cwd()).info.get('solo-api')).toMatchObject({
        port: fragment.port,
        release: 'story-two',
      })
    } finally {
      await runner.shutdown()
    }
  }, 15000)
})

describe('dev-context fragment — F6a: two apps write two distinct fragments', () => {
  it('produces one fragment per app and the merged readLocalSet contains both packages', async () => {
    const root = temp.register(
      makeMonorepo([
        { name: 'alpha', packageName: 'alpha-api', withHandler: true },
        { name: 'beta', packageName: 'beta-api', withHandler: true },
      ]),
    )

    delete process.env.PORT
    delete process.env.ALPHA_PORT
    delete process.env.BETA_PORT
    process.chdir(root)

    const runner = new DevServerRunner({}, noopBuild)

    await runner.start()

    try {
      const alpha = readFragment('alpha')
      const beta = readFragment('beta')

      expect(alpha.package).toBe('alpha-api')
      expect(beta.package).toBe('beta-api')

      // Distinct ephemeral ports (collision-free by listen(0)).
      expect(alpha.port).not.toBe(beta.port)

      // The real write+merge path: both packages land in the merged localSet.
      const localSet = readLocalSet(process.cwd())

      expect(localSet.has('alpha-api')).toBe(true)
      expect(localSet.has('beta-api')).toBe(true)

      const info = readLocalContext(process.cwd()).info

      expect(info.get('alpha-api')?.port).toBe(alpha.port)
      expect(info.get('beta-api')?.port).toBe(beta.port)
    } finally {
      await runner.shutdown()
    }
  }, 15000)
})

describe('dev-context fragment — M2: a restart refreshes the recorded port', () => {
  it('rewrites the fragment to the live restarted server (not a stale port)', async () => {
    const root = temp.register(makeMonorepo([{ name: 'omega', packageName: 'omega-api', withHandler: true }]))

    delete process.env.PORT
    delete process.env.OMEGA_PORT
    process.chdir(root)

    const runner = new DevServerRunner({}, noopBuild)

    await runner.start()

    try {
      const before = readFragment('omega')

      // Restart via the shared runRestart path (rebinds an ephemeral port, rewrites the fragment).
      const internal = runner as unknown as RunnerInternals

      await internal.restart([internal.appServers[0]!.app])

      const after = readFragment('omega')

      // The fragment was refreshed and points at the LIVE restarted server.
      expect(after.writtenAt).toBeGreaterThan(before.writtenAt)

      const health = (await (await fetch(`http://127.0.0.1:${after.port}/__health`)).json()) as { app: string }

      expect(health.app).toBe('omega')
      expect(after.port).not.toBe(DEFAULT_PORT)
    } finally {
      await runner.shutdown()
    }
  }, 15000)
})

describe('dev-context fragment — shutdown removes only the runner own fragments', () => {
  it('deletes its own <app>.json and leaves a foreign fragment untouched', async () => {
    const root = temp.register(makeMonorepo([{ name: 'gamma', packageName: 'gamma-api', withHandler: true }]))

    delete process.env.PORT
    delete process.env.GAMMA_PORT
    process.chdir(root)

    // A foreign runner's fragment already present in the shared directory.
    const dir = contextDir()

    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ package: 'other-api', port: 9999, pid: 1 }))

    const runner = new DevServerRunner({}, noopBuild)

    await runner.start()

    // While running, the runner's own fragment exists alongside the foreign one.
    expect(fs.existsSync(path.join(dir, 'gamma.json'))).toBe(true)

    await runner.shutdown()

    // Only its own fragment is removed; the foreign one is untouched.
    expect(fs.existsSync(path.join(dir, 'gamma.json'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'other.json'))).toBe(true)
  }, 15000)
})
