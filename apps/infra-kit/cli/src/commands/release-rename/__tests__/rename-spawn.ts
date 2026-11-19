import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { afterAll, beforeAll, expect } from 'vitest'

import type { SpawnedRun } from 'src/__tests__/helpers/agent-cli-fixture'
import { buildCliBundle } from 'src/__tests__/helpers/build-cli-bundle'
import { isReadOnlyGhCall, makeReleaseRenameFixture } from 'src/__tests__/helpers/release-rename-fixture'
import type {
  FakeJiraVersion,
  FakePr,
  ReleaseRenameFixture,
  ReleaseRenameFixtureOptions,
  RunCliOverrides,
} from 'src/__tests__/helpers/release-rename-fixture'
import { formatPrTitle, parseReleaseRef } from 'src/lib/release-id'

/**
 * @fileoverview
 * Shared arrange/assert for the spawned `release rename` suites: one bundle per file, one fresh
 * fixture per case, and the zero-mutation measures of plan §5 AC 1.
 */

/** A bundle build plus a git-heavy fixture comfortably exceed vitest's 5 s default. */
export const SPAWN_TEST_TIMEOUT_MS = 60_000

/** Builds the CLI bundle once for the calling file; read `cliPath()` inside a test, never at import time. */
export const registerCliBundle = (prefix: string): (() => string) => {
  let outDir = ''
  let cliPath = ''

  beforeAll(async () => {
    const built = await buildCliBundle(prefix)

    outDir = built.outDir
    cliPath = built.cliPath
  }, 120_000)

  afterAll(() => {
    if (outDir) rmSync(outDir, { force: true, recursive: true })
  })

  return () => {
    return cliPath
  }
}

/**
 * Runs `body` against a fresh fixture, then requires that neither fake saw an argv it does not model —
 * an unhandled call means the handler or the fake is wrong, and either way the case proves nothing.
 */
export const withFixture = async (
  cliPath: string,
  options: ReleaseRenameFixtureOptions,
  body: (fixture: ReleaseRenameFixture) => Promise<void>,
): Promise<void> => {
  const fixture = await makeReleaseRenameFixture({ ...options, cliPath })

  try {
    await body(fixture)
    expect(fixture.ghUnhandled()).toStrictEqual([])
    expect(fixture.orcaUnhandled()).toStrictEqual([])
  } finally {
    await fixture.cleanup()
  }
}

export const AGENT_FLAGS = ['--agent', '--json']

export const runRename = (
  fixture: ReleaseRenameFixture,
  positionals: string[],
  options: { yes?: boolean; json?: boolean; overrides?: RunCliOverrides } = {},
): Promise<SpawnedRun> => {
  // `--json` silences the logger, so the human lines are only visible on an `--agent`-only run.
  const flags = options.json === false ? ['--agent'] : AGENT_FLAGS
  const args = ['release', 'rename', ...positionals, ...flags, ...(options.yes ? ['--yes'] : [])]

  return fixture.runCli(args, { deadlineMs: 45_000, ...options.overrides })
}

export const output = (run: SpawnedRun): string => {
  return `exit ${run.code}${run.timedOut ? ' (timed out)' : ''}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`
}

export interface StateSnapshot {
  origin: Record<string, string>
  clone: Record<string, string>
  ghCalls: number
  jiraCalls: number
}

export const snapshot = (fixture: ReleaseRenameFixture): StateSnapshot => {
  return {
    origin: fixture.originRefs(),
    clone: fixture.cloneRefs(),
    ghCalls: fixture.ghLog().length,
    jiraCalls: fixture.jiraRequests().length,
  }
}

/** Plan §5 AC 1's three measures: refs on both sides unchanged, only read-only gh argv, only Jira GETs. */
export const expectNothingMutated = (fixture: ReleaseRenameFixture, before: StateSnapshot): void => {
  expect(fixture.originRefs()).toStrictEqual(before.origin)
  expect(fixture.cloneRefs()).toStrictEqual(before.clone)

  const writes = fixture
    .ghLog()
    .slice(before.ghCalls)
    .filter((argv) => {
      return !isReadOnlyGhCall(argv)
    })

  expect(writes).toStrictEqual([])

  const jiraMethods = fixture
    .jiraRequests()
    .slice(before.jiraCalls)
    .map((request) => {
      return request.method
    })

  expect(new Set(jiraMethods)).toStrictEqual(new Set(jiraMethods.length === 0 ? [] : ['GET']))
}

/** Plain git against the fixture's env, for the arrange/assert steps of a case. */
export const git = (fixture: ReleaseRenameFixture, cwd: string, args: string[]): string => {
  const result = spawnSync('/usr/bin/git', args, { cwd, env: fixture.env, encoding: 'utf8' })

  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`)

  return result.stdout
}

/** A `--yes` rename that must succeed; returns the run for output assertions. */
export const renameOk = async (
  fixture: ReleaseRenameFixture,
  positionals: string[] = ['1.2.0', '1.3.0'],
  options: { json?: boolean; overrides?: RunCliOverrides } = {},
): Promise<SpawnedRun> => {
  const run = await runRename(fixture, positionals, { ...options, yes: true })

  expect(run.code, output(run)).toBe(0)

  return run
}

export const OLD_BRANCH = 'release/v1.2.0'
export const NEW_BRANCH = 'release/v1.3.0'
export const NEW_SUFFIX = 'v1.3.0'
export const NEW_JIRA_NAME = 'v1.3.0'

export const FORWARD_LINE = 'infra-kit release rename 1.2.0 1.3.0'
export const UNDO_LINE = 'to undo afterwards: infra-kit release rename 1.3.0 1.2.0'
export const HALF_RENAMED_WARNING =
  'do not run release remove 1.2.0 or release create 1.3.0 until this rename is re-run to completion'

/** The JSON `message` (the residue report or refusal, with real newlines) plus stderr. */
export const reportText = (run: SpawnedRun): string => {
  return `${typeof run.json?.message === 'string' ? run.json.message : ''}\n${run.stderr}`
}

/** A child PR on `release/<old>` whose head is pushed to origin, as GitHub requires for it to stay open. */
export const addChildPr = (fixture: ReleaseRenameFixture, head = 'feature/child'): number => {
  fixture.recreateBranchOnOrigin(head, fixture.originSha(fixture.branch)!)
  fixture.pushAsTeammate(head)

  return fixture.addPr({ headRefName: head, baseRefName: fixture.branch })
}

export const prByNumber = (fixture: ReleaseRenameFixture, number: number): FakePr => {
  const pr = fixture.ghState().prs.find((candidate) => {
    return candidate.number === number
  })

  if (!pr) throw new Error(`no PR #${number}`)

  return pr
}

export const openPrsOn = (fixture: ReleaseRenameFixture, heads: string[]): FakePr[] => {
  return fixture.ghState().prs.filter((pr) => {
    return pr.state === 'OPEN' && heads.includes(pr.headRefName)
  })
}

export const markerComments = (pr: FakePr): string[] => {
  return pr.comments
    .map((comment) => {
      return comment.body
    })
    .filter((body) => {
      return body.includes('Superseded by #')
    })
}

export const jiraVersion = (fixture: ReleaseRenameFixture): FakeJiraVersion => {
  const version = fixture.jiraVersions().find((candidate) => {
    return candidate.id === fixture.jiraVersionId
  })

  if (!version) throw new Error('the seeded Jira version is gone')

  return version
}

/** The preflight snapshot AC 4-7 compare against. */
export interface RenameBaseline {
  remoteSha: string
  localSha: string | null
  jira: FakeJiraVersion
  porcelain: string | null
  children: number[]
}

export const captureBaseline = (fixture: ReleaseRenameFixture, children: number[] = []): RenameBaseline => {
  return {
    remoteSha: fixture.originSha(fixture.branch)!,
    localSha: fixture.cloneSha(`refs/heads/${fixture.branch}`),
    jira: jiraVersion(fixture),
    porcelain: existsSync(fixture.worktreeDir) ? git(fixture, fixture.worktreeDir, ['status', '--porcelain']) : null,
    children,
  }
}

const expectJiraConverged = (fixture: ReleaseRenameFixture, baseline: RenameBaseline): void => {
  expect(jiraVersion(fixture)).toMatchObject({
    name: NEW_JIRA_NAME,
    description: baseline.jira.description,
    releaseDate: baseline.jira.releaseDate,
  })
}

const expectGitConverged = (fixture: ReleaseRenameFixture, baseline: RenameBaseline, remoteSha: string): void => {
  expect(fixture.originSha(NEW_BRANCH)).toBe(remoteSha)
  expect(fixture.originSha(OLD_BRANCH)).toBeNull()
  expect(fixture.cloneSha(`refs/heads/${OLD_BRANCH}`)).toBeNull()
  expect(fixture.cloneSha(`refs/remotes/origin/${OLD_BRANCH}`)).toBeNull()

  if (baseline.localSha === null) return

  expect(fixture.cloneSha(`refs/heads/${NEW_BRANCH}`)).toBe(baseline.localSha)
  expect(git(fixture, fixture.repoDir, ['rev-parse', '--abbrev-ref', `${NEW_BRANCH}@{upstream}`]).trim()).toBe(
    `origin/${NEW_BRANCH}`,
  )
}

/** Returns the replacement PR's number. */
const expectPrsConverged = (fixture: ReleaseRenameFixture, baseline: RenameBaseline): number => {
  const open = openPrsOn(fixture, [OLD_BRANCH, NEW_BRANCH])

  expect(open).toHaveLength(1)

  const [newPr] = open

  expect(newPr).toMatchObject({
    headRefName: NEW_BRANCH,
    baseRefName: fixture.baseBranch,
    title: formatPrTitle(parseReleaseRef('1.3.0'), fixture.type),
  })

  const oldPr = prByNumber(fixture, 1)

  expect(oldPr.state).toBe('CLOSED')
  expect(markerComments(oldPr)).toHaveLength(1)
  expect(markerComments(oldPr)[0]).toMatch(new RegExp(`^Superseded by #${newPr!.number}(?!\\d)`, 'u'))

  for (const child of baseline.children) {
    expect(prByNumber(fixture, child)).toMatchObject({ state: 'OPEN', baseRefName: NEW_BRANCH })
  }

  return newPr!.number
}

const expectWorktreeConverged = (fixture: ReleaseRenameFixture, baseline: RenameBaseline): void => {
  if (baseline.porcelain === null) return

  const newPath = fixture.worktreePathFor(NEW_SUFFIX)

  expect(existsSync(fixture.worktreeDir)).toBe(false)
  expect(git(fixture, newPath, ['branch', '--show-current']).trim()).toBe(NEW_BRANCH)
  expect(git(fixture, newPath, ['status', '--porcelain'])).toBe(baseline.porcelain)
}

/**
 * Plan §5 AC 4-7 against the preflight baseline. `remoteSha` overrides the expected origin tip when the
 * old branch legitimately moved (a teammate's push the rename carried over). Returns the new PR number.
 */
export const expectConverged = (
  fixture: ReleaseRenameFixture,
  baseline: RenameBaseline,
  remoteSha = baseline.remoteSha,
): number => {
  expectJiraConverged(fixture, baseline)
  expectGitConverged(fixture, baseline, remoteSha)

  const newPr = expectPrsConverged(fixture, baseline)

  expectWorktreeConverged(fixture, baseline)

  return newPr
}

const jiraPuts = (fixture: ReleaseRenameFixture, since: number): number => {
  return fixture
    .jiraRequests()
    .slice(since)
    .filter((request) => {
      return request.method !== 'GET'
    }).length
}

/** A converged re-run: exit 0, "already renamed", nothing mutated anywhere, the follow-ups printed. */
export const expectAlreadyRenamed = async (fixture: ReleaseRenameFixture): Promise<SpawnedRun> => {
  const before = snapshot(fixture)
  const run = await runRename(fixture, ['1.2.0', '1.3.0'], { yes: true })

  expect(run.code, output(run)).toBe(0)
  expect(run.json, output(run)).toMatchObject({ outcome: 'already-renamed', renamedSteps: [] })
  expect(run.json?.followUps).toContainEqual({
    label: `teammates with a local ${OLD_BRANCH}`,
    command: `git fetch --prune && git branch -m ${OLD_BRANCH} ${NEW_BRANCH}`,
  })
  expectNothingMutated(fixture, before)
  expect(jiraPuts(fixture, before.jiraCalls)).toBe(0)

  return run
}

/** A run that stopped at `step` (exit 1) and printed the residue report with both re-run lines. */
export const expectFailedAt = (run: SpawnedRun, step: string): string => {
  const text = reportText(run)

  expect(run.code, output(run)).toBe(1)
  expect(text, output(run)).toMatch(new RegExp(`^  ${step}: NOT renamed \\(failed here\\)$`, 'mu'))
  expect(text).toContain(FORWARD_LINE)
  expect(text).toContain(UNDO_LINE)

  return text
}
