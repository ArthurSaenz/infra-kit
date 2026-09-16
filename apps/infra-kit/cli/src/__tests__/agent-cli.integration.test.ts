import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildCliBundle } from 'src/__tests__/helpers/build-cli-bundle'
import { createReleaseRemoveFormProvider } from 'src/lib/release-remove-form'

import {
  FIXTURE_RELEASE,
  ensureReleaseWorktree,
  makeAgentCliFixture,
  readGhLog,
  removeReleaseWorktree,
  runCli,
  runCliOnPty,
} from './helpers/agent-cli-fixture'
import type { AgentCliFixture, PtyRun, SpawnedRun } from './helpers/agent-cli-fixture'

/**
 * @fileoverview
 *
 * The spawned-process lane for agent mode (plan §5 AC1/AC1b/AC2/AC3/AC4/AC5/AC10/AC14, §7
 * Integration): the built `cli.js` run against a git fixture, with the agent signals set in the
 * child's ENV or argv and the refusal payloads read off its stdout — the only way to prove that
 * `entry/cli.ts`, the `preAction` hook, the guards and `exitForError` compose into the documented
 * exit code + JSON, rather than that each piece works in isolation.
 *
 * WHY ONE FILE. `vitest.config.ts` pins `pool: 'forks'`, so parallelism is per-FILE; every case here
 * spawns a node process against ONE shared fixture whose worktree state the cases hand to each other
 * (AC2 creates, AC14 refuses to touch, AC10 dirties). One file = one fork = one ordered story.
 *
 * WHERE WE BUILD. `buildCliBundle` builds every `src/entry/*.ts` — `cli.js` included — into this
 * package's `node_modules/.cache`, for the reason its own header gives (externalized deps resolve by
 * walking UP to a `node_modules`; tmpdir has none).
 */

/** Recursively key-sort so two payloads compare as the same JSON text, key order included. */
const canonical = (value: unknown): string => {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort)

    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => {
            return [key, sort((input as Record<string, unknown>)[key])]
          }),
      )
    }

    return input
  }

  return JSON.stringify(sort(value), null, 2)
}

const expectJson = (run: SpawnedRun | PtyRun): Record<string, unknown> => {
  const context =
    'pty' in run
      ? `exit=${run.code} timedOut=${run.timedOut}\n--- stdout ---\n${run.stdout}\n--- pty ---\n${run.pty}`
      : `exit=${run.code} timedOut=${run.timedOut}\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`

  expect(run.timedOut, `deadline hit:\n${context}`).toBe(false)
  expect(run.json, `stdout is not one JSON object:\n${context}`).toBeDefined()

  return run.json!
}

let outDir = ''
let cliPath = ''
let fixture: AgentCliFixture

const cli = (args: string[], env?: Record<string, string | undefined>): Promise<SpawnedRun> => {
  return runCli({ cliPath, fixture, args, env })
}

beforeAll(async () => {
  const built = await buildCliBundle('agent-cli-')

  outDir = built.outDir
  cliPath = built.cliPath
  fixture = makeAgentCliFixture()
}, 90_000)

afterAll(() => {
  if (fixture) removeReleaseWorktree(fixture)
  if (outDir) rmSync(outDir, { force: true, recursive: true })
  if (fixture) rmSync(join(fixture.repoDir, '..'), { force: true, recursive: true })
})

describe('agent-mode refusals (spawned cli.js)', () => {
  it('ac1: CLAUDECODE=1 + non-TTY stdin + `worktrees add --versions <v> --json` → exit 2, confirmation_required, rerun ends in --yes, no prompt frame', async () => {
    const argv = ['worktrees', 'add', '--versions', FIXTURE_RELEASE.ref, '--json']
    const run = await cli(argv, { CLAUDECODE: '1' })
    const json = expectJson(run)

    expect(run.code).toBe(2)
    expect(json.status).toBe('confirmation_required')
    expect(json.agentMode).toBe('env')
    expect(json.rerun).toStrictEqual([...argv, '--yes'])
    expect(existsSync(fixture.releaseWorktreeDir), 'a refusal must create nothing').toBe(false)

    // The inquirer frame this refusal replaces is `? Are you sure … (Y/n)` on stderr. The QUESTION
    // itself legitimately travels in the payload's `message` (that is what the agent shows the
    // human), so stdout is only checked for the frame's answer glyph.
    expect(run.stderr).not.toContain('Are you sure')
    expect(run.stderr).not.toMatch(/\((?:Y\/n|y\/N)\)/)
    expect(run.stdout).not.toMatch(/\((?:Y\/n|y\/N)\)/)
  })

  it('ac1b: CLAUDECODE=1 + `worktrees add --json` (no --versions) → exit 2, argument_required for `versions`, no choices', async () => {
    const run = await cli(['worktrees', 'add', '--json'], { CLAUDECODE: '1' })
    const json = expectJson(run)

    expect(run.code).toBe(2)
    expect(json.status).toBe('argument_required')
    expect(json.argument).toBe('versions')
    expect(json.agentMode).toBe('env')
    // Not a form-backed tool: the candidates are what `release list --json` returns, so no `choices`.
    expect(json).not.toHaveProperty('choices')
  })

  it('ac2: `worktrees add --versions <v> --yes --agent --json` creates the worktree and reports the wire shape', async () => {
    removeReleaseWorktree(fixture)

    const run = await cli(['worktrees', 'add', '--versions', FIXTURE_RELEASE.ref, '--yes', '--agent', '--json'])
    const json = expectJson(run)

    expect(run.code).toBe(0)
    expect(existsSync(join(fixture.releaseWorktreeDir, 'infra-kit.json'))).toBe(true)
    // The three `orca*` arrays are part of the wire shape even when nothing was opened: the fixture
    // hides the developer's `orca` from PATH, so headless-false resolution leaves them empty.
    expect(json).toStrictEqual({
      createdWorktrees: [FIXTURE_RELEASE.branch],
      count: 1,
      orcaOpened: [],
      orcaSkipped: [],
      orcaHidden: [],
    })
  }, 30_000)
})

describe('form-backed refusal', () => {
  it('ac3: `release remove --agent --json` (no version) → exit 2, argument_required for `version`, choices = the release-remove form rows', async () => {
    const run = await cli(['release', 'remove', '--agent', '--json'])
    const json = expectJson(run)

    expect(run.code).toBe(2)
    expect(json.status).toBe('argument_required')
    expect(json.argument).toBe('version')
    expect(json.agentMode).toBe('flag')

    // The expected rows come from the SAME provider the handler consults, built in-process against
    // the fixture's fake `gh` (PATH swapped for the duration of the call; zx reads it per spawn).
    const parentPath = process.env.PATH
    let expectedChoices: unknown

    process.env.PATH = fixture.env.PATH

    try {
      const schema = await createReleaseRemoveFormProvider().buildRequestedSchema({})

      expect(schema, 'the form builder found no rows against the fake gh').not.toBeNull()
      expectedChoices = z.toJSONSchema(schema!)
    } finally {
      process.env.PATH = parentPath
    }

    expect(canonical(json.choices)).toBe(canonical(expectedChoices))
  }, 45_000)
})

describe('cli-only commands', () => {
  it('ac4: `release deliver --version <v> --yes --agent` → exit 2 naming the CLI-only rule on stderr; with --json, status refused', async () => {
    const argv = ['release', 'deliver', '--version', FIXTURE_RELEASE.version, '--yes', '--agent']
    const plain = await cli(argv)

    expect(plain.timedOut, plain.stderr).toBe(false)
    expect(plain.code).toBe(2)
    expect(plain.stdout.trim()).toBe('')
    expect(plain.stderr).toContain('CLI-only')

    const json = expectJson(await cli([...argv, '--json']))

    expect(json.status).toBe('refused')
    expect(json.agentMode).toBe('flag')
    // Nothing was merged or dispatched: the fake `gh` saw only the PR lookup for the branch.
    expect(
      readGhLog(fixture).filter((line) => {
        return line.startsWith('pr merge') || line.startsWith('workflow run')
      }),
    ).toStrictEqual([])
  })
})

describe('ac5: protectedEnvs "cli-only"', () => {
  const argv = [
    'release',
    'deploy-all',
    '--from',
    'ci',
    '--version',
    FIXTURE_RELEASE.version,
    '--env',
    'prod',
    '--yes',
    '--json',
  ]
  const AGENT_REFUSAL = '"prod" is withheld from agents in this project (protectedEnvs: "cli-only")'

  // `assertDeployable` throws a structured `refused` (exit 2, nothing ran): the payload on stdout
  // under `--json`, the agent-worded message on stderr. Returns the exit code so each case's own
  // `expect` carries the verdict.
  const refusalExit = (run: SpawnedRun): number | null => {
    const json = expectJson(run)

    expect(json).toMatchObject({ status: 'refused', env: 'prod' })
    expect(json.agentMode).not.toBeNull()
    expect(run.stderr).toContain(AGENT_REFUSAL)

    return run.code
  }

  const expectAllowed = (run: SpawnedRun | PtyRun): void => {
    const json = expectJson(run)

    expect(run.code).toBe(0)
    expect(json).toMatchObject({ environment: 'prod', releaseBranch: FIXTURE_RELEASE.branch, success: true })
  }

  const dispatches = (): string[] => {
    return readGhLog(fixture).filter((line) => {
      return line.startsWith('workflow run deploy-all.yml')
    })
  }

  it('--agent refuses', async () => {
    expect(refusalExit(await cli([...argv, '--agent']))).toBe(2)
  })

  it('with CLAUDECODE=1 + non-TTY stdin refuses', async () => {
    expect(refusalExit(await cli(argv, { CLAUDECODE: '1' }))).toBe(2)
  })

  it('with INFRA_KIT_AGENT=1 refuses', async () => {
    expect(refusalExit(await cli(argv, { INFRA_KIT_AGENT: '1' }))).toBe(2)
  })

  it('--agent + INFRA_KIT_AGENT=0 still refuses (the variable never demotes the flag)', async () => {
    expect(refusalExit(await cli([...argv, '--agent'], { INFRA_KIT_AGENT: '0' }))).toBe(2)
  })

  it('with CLAUDECODE=1 + INFRA_KIT_AGENT=0 + non-TTY stdin allows — the dispatch reaches the fake gh', async () => {
    const before = dispatches().length

    expectAllowed(await cli(argv, { CLAUDECODE: '1', INFRA_KIT_AGENT: '0' }))
    expect(dispatches()).toHaveLength(before + 1)
  })

  it('with CLAUDECODE=1 on a real PTY allows (a human at a terminal Claude Code opened)', async () => {
    const before = dispatches().length
    const run = await runCliOnPty({ cliPath, fixture, args: argv, env: { CLAUDECODE: '1' } })

    expectAllowed(run)
    expect(dispatches()).toHaveLength(before + 1)
  }, 20_000)
})

describe('worktrees remove', () => {
  it('ac14: `worktrees remove --versions <v> --json` on a PTY with no agent signals → exit 2, confirmation_required, message names --yes, nothing removed', async () => {
    ensureReleaseWorktree(fixture)

    const argv = ['worktrees', 'remove', '--versions', FIXTURE_RELEASE.ref, '--json']
    const run = await runCliOnPty({
      cliPath,
      fixture,
      args: argv,
      env: { CLAUDECODE: undefined, INFRA_KIT_AGENT: undefined },
    })
    const json = expectJson(run)

    expect(run.code).toBe(2)
    expect(json.status).toBe('confirmation_required')
    expect(json.agentMode).toBeNull()
    expect(json.rerun).toStrictEqual([...argv, '--yes'])
    expect(run.pty).toContain('--yes')
    expect(existsSync(fixture.releaseWorktreeDir)).toBe(true)
  }, 20_000)

  it('ac10: `worktrees remove --versions <v> --yes --agent --json` on a dirty worktree → exit 1, partial_failure', async () => {
    ensureReleaseWorktree(fixture)
    // An untracked file is what makes `git worktree remove` (no `--force`) refuse.
    writeFileSync(join(fixture.releaseWorktreeDir, 'scratch.txt'), 'uncommitted\n')

    const run = await cli(['worktrees', 'remove', '--versions', FIXTURE_RELEASE.ref, '--yes', '--agent', '--json'])
    const json = expectJson(run)

    expect(run.code).toBe(1)
    expect(json).toStrictEqual({
      status: 'partial_failure',
      removedWorktrees: [],
      failedWorktrees: [FIXTURE_RELEASE.branch],
      count: 0,
    })
    expect(existsSync(join(fixture.releaseWorktreeDir, 'scratch.txt'))).toBe(true)
  }, 30_000)
})
