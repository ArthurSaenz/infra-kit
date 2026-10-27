import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { $ } from 'zx'

import { compareRates, computeClassStats, toRate, wilsonInterval } from '../analyze'
import type { ParsedCommit } from '../analyze'
import { collectChangeStats } from '../change-stats'

/**
 * Real git in a temp dir: trailer parsing, `This reverts commit` bodies and committer timestamps are
 * git's formats, and a hand-built log string would only encode our belief about them.
 */

const HOUR = 3600
const DAY = 24 * HOUR
const NOW_MS = Date.UTC(2026, 9, 27, 12, 0, 0)
const NOW = NOW_MS / 1000

const tmpRoots: string[] = []
let repo: string

const git = async (args: string[], dateSeconds?: number): Promise<string> => {
  const date = dateSeconds === undefined ? undefined : `@${dateSeconds} +0000`
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env
  const config = ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false']
  const result = await $({ cwd: repo, env, quiet: true })`git ${[...config, ...args]}`

  return result.stdout.trim()
}

/** Commit `files` (contents changed to force a diff) at `ageSeconds` before NOW; returns the sha. */
const commit = async (message: string, files: string[], ageSeconds: number): Promise<string> => {
  await Promise.all(
    files.map((file) => {
      return fs.writeFile(path.join(repo, file), `${message}\n${ageSeconds}\n`)
    }),
  )
  await git(['add', ...files])
  await git(['commit', '-q', '--no-verify', '-m', message], NOW - ageSeconds)

  return git(['rev-parse', 'HEAD'])
}

const AGENT_TRAILER = '\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'

const stats = (sinceDays = 90) => {
  return collectChangeStats({ cwd: repo, sinceDays, nowMs: NOW_MS })
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ik-change-stats-'))
  tmpRoots.push(repo)
  await $({ cwd: repo, quiet: true })`git init -q -b main`
})

afterAll(async () => {
  await Promise.all(
    tmpRoots.map((root) => {
      return fs.rm(root, { recursive: true, force: true })
    }),
  )
})

describe('collectChangeStats — trailer classification', () => {
  it('classes Co-Authored-By: Claude and Claude-Session trailers as agent, anything else as human', async () => {
    await commit(`[FE] agent one${AGENT_TRAILER}`, ['a.ts'], 10 * DAY)
    await commit('[FE] agent two\n\nClaude-Session: https://claude.ai/code/session_x', ['b.ts'], 9 * DAY)
    await commit('[FE] human\n\nCo-Authored-By: Jane <jane@example.com>', ['c.ts'], 8 * DAY)
    await commit('[FE] mentions Claude-Session: inline only', ['d.ts'], 7 * DAY)

    const { classes } = await stats()

    expect(classes.agent.commits).toBe(2)
    expect(classes.human.commits).toBe(2)
    expect(classes.total.commits).toBe(4)
  })
})

describe('collectChangeStats — revert pairing', () => {
  it('pairs a `This reverts commit <sha>` body and a bare `Revert "<subject>"` with their originals', async () => {
    const first = await commit(`[BE] add cache${AGENT_TRAILER}`, ['cache.ts'], 20 * DAY)

    await commit('[BE] add queue', ['queue.ts'], 19 * DAY)
    await commit('[BE] untouched', ['other.ts'], 18 * DAY)
    await commit(`Revert "[BE] add cache"\n\nThis reverts commit ${first}.`, ['cache.ts'], 17 * DAY)
    await commit('Revert "[BE] add queue" (#12)', ['queue.ts'], 16 * DAY)
    // A squash whose branch reverted something carries the line in its body but is a change, not a revert.
    await commit(`[BE] squash\n\nThis reverts commit ${first}.`, ['squash.ts'], 15 * DAY)

    const { classes } = await stats()

    expect(classes.agent.revertRate).toMatchObject({ hits: 1, n: 1 })
    // The two reverts are human-authored but leave the denominator: 3 human changes, 1 reverted.
    expect(classes.human).toMatchObject({ commits: 5, reverts: 2, changes: 3 })
    expect(classes.human.revertRate).toMatchObject({ hits: 1, n: 3 })
    expect(classes.total.revertRate).toMatchObject({ hits: 2, n: 4 })
  })
})

describe('collectChangeStats — 72h follow-up-fix window', () => {
  it('counts a fix on a shared file at exactly 72h and not at 72h + 1s', async () => {
    const base = 30 * DAY

    await commit('[FE] feature inside', ['in.ts'], base)
    await commit('[FE] fix inside', ['in.ts'], base - 72 * HOUR)
    await commit('[FE] feature outside', ['out.ts'], base)
    await commit('[FE] fix outside', ['out.ts'], base - 72 * HOUR - 1)

    const { classes } = await stats()

    // 4 changes; the two fix commits are changes too, with no later fix of their own.
    expect(classes.human.followUpFixRate).toMatchObject({ hits: 1, n: 4 })
  })

  it('ignores a fix that shares only a lockfile, a non-fix subject, and `prefix`/`fixture` words', async () => {
    const base = 30 * DAY

    await commit('[FE] feature', ['x.ts', 'pnpm-lock.yaml'], base)
    await commit('[FE] fix deps', ['y.ts', 'pnpm-lock.yaml'], base - HOUR)
    await commit('[FE] tweak x', ['x.ts'], base - 2 * HOUR)
    await commit('[FE] rename prefix and fixture in x', ['x.ts'], base - 3 * HOUR)

    const { classes } = await stats()

    expect(classes.human.followUpFixRate.hits).toBe(0)
  })

  it('leaves changes younger than 72h out of the follow-up denominator (right-censored)', async () => {
    await commit('[FE] old', ['a.ts'], 10 * DAY)
    await commit('[FE] recent', ['b.ts'], 2 * DAY)

    const { classes } = await stats()

    expect(classes.human.revertRate.n).toBe(2)
    expect(classes.human.followUpFixRate.n).toBe(1)
  })
})

describe('collectChangeStats — range', () => {
  it('returns zeroed classes with null rates when no commit falls in the window', async () => {
    await commit('[FE] ancient', ['a.ts'], 200 * DAY)

    const result = await stats(90)

    expect(result.classes.total).toMatchObject({ commits: 0, changes: 0 })
    expect(result.classes.total.revertRate).toEqual({ hits: 0, n: 0, rate: null, ci95: null })
    expect(result.comparison.revertRate.suppressed).toBe(true)
  })

  it('returns an empty result on a repo with no commits at all', async () => {
    const result = await stats()

    expect(result.classes.total.commits).toBe(0)
  })
})

describe('wilsonInterval', () => {
  it('matches reference Wilson 95% bounds', () => {
    expect(wilsonInterval(0, 10)).toEqual({ low: 0, high: expect.closeTo(0.2775, 4) })
    expect(wilsonInterval(5, 10)).toEqual({ low: expect.closeTo(0.2366, 4), high: expect.closeTo(0.7634, 4) })
    expect(wilsonInterval(10, 10)).toEqual({ low: expect.closeTo(0.7225, 4), high: expect.closeTo(1, 6) })
    expect(wilsonInterval(0, 0)).toBeNull()
  })
})

describe('compareRates — n < 30 suppression', () => {
  it('suppresses when either side has n < 30 and names the small side', () => {
    const result = compareRates(toRate(1, 29), toRate(3, 100))

    expect(result).toEqual({ suppressed: true, reason: 'agent n=29 < 30', difference: null, intervalsOverlap: null })
  })

  it('compares at n = 30 on both sides', () => {
    const result = compareRates(toRate(3, 30), toRate(30, 30))

    expect(result.suppressed).toBe(false)
    expect(result.difference).toBeCloseTo(-0.9, 4)
    expect(result.intervalsOverlap).toBe(false)
  })

  it('holds for a class built from 30 parsed agent commits vs 5 human ones', () => {
    const make = (index: number, agent: boolean): ParsedCommit => {
      return {
        hash: `${agent ? 'a' : 'b'}${index}`,
        committedAt: NOW - 10 * DAY + index,
        subject: `change ${index}`,
        body: agent ? `change ${index}${AGENT_TRAILER}` : `change ${index}`,
        files: [`f${index}.ts`],
      }
    }

    const commits = [
      ...Array.from({ length: 30 }, (_, index) => {
        return make(index, true)
      }),
      ...Array.from({ length: 5 }, (_, index) => {
        return make(100 + index, false)
      }),
    ]

    const classes = computeClassStats(commits, NOW)

    expect(compareRates(classes.agent.revertRate, classes.human.revertRate)).toMatchObject({
      suppressed: true,
      reason: 'human n=5 < 30',
    })
  })
})
