import { Client } from '@modelcontextprotocol/client'
import type { ElicitRequestFormParams } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createReleaseRemoveFormProvider } from 'src/lib/release-remove-form'
import { buildMcpBundle } from 'src/mcp/__tests__/helpers/mcp-harness'

import {
  FIXTURE_RELEASE,
  FIXTURE_SESSION,
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
 * WHERE WE BUILD. `buildMcpBundle` builds every `src/entry/*.ts` — `cli.js` included — into this
 * package's `node_modules/.cache`, for the reason its own header gives (externalized deps resolve by
 * walking UP to a `node_modules`; tmpdir has none).
 *
 * MCP PARITY. The "same fixture over MCP" halves drive the built `mcp.js` through the v2 client the
 * e2e lane uses, with the SAME child env and cwd as the CLI spawns, so a difference in a payload can
 * only come from the transport — which is exactly the claim.
 */

interface McpToolResult {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: { type: string; text?: string }[]
}

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

const withoutKeys = (value: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> => {
  const copy = { ...value }

  for (const key of keys) delete copy[key]

  return copy
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

const textOf = (result: McpToolResult): string => {
  return (result.content ?? [])
    .map((block) => {
      return block.text ?? ''
    })
    .join('\n')
}

let outDir = ''
let cliPath = ''
let mcpPath = ''
let fixture: AgentCliFixture
/** One long-lived bare (form-less) client; every parity half and every gate round-trip goes through it. */
let mcp: Client
const clients: Client[] = []

const connectMcp = async (options?: ConstructorParameters<typeof Client>[1]): Promise<Client> => {
  const client = new Client({ name: 'agent-cli-integration', version: '0.0.0' }, options)

  // Same env as the CLI spawns — `CLAUDE_PLUGIN_ROOT` is absent by construction (the fixture env is
  // built from scratch), so the server serves the legacy tool-name spelling the calls below use.
  await client.connect(
    // `stderr: 'ignore'` — the served child's pino stream would otherwise inherit this runner's
    // stderr and interleave with the reporter; nothing here asserts on the server's log lines.
    new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath],
      env: fixture.env,
      cwd: fixture.repoDir,
      stderr: 'ignore',
    }),
  )

  clients.push(client)

  return client
}

const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> => {
  return (await mcp.callTool({ name, arguments: args }, { timeout: 15_000 })) as McpToolResult
}

/**
 * Round 1 mints the token, round 2 executes with the SAME arguments plus `confirm` — the gate binds
 * the token to the argv it was minted over (memory: confirm-gate-does-not-bind-arguments, FIXED).
 */
const callGatedTool = async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
  const gate = await callTool(name, args)
  const confirmToken = gate.structuredContent?.confirmToken

  expect(gate.isError, `round 1 must be the gate:\n${canonical(gate)}`).toBe(true)
  expect(gate.structuredContent?.status).toBe('confirmation_required')
  expect(confirmToken, 'round 1 must hand out a confirmToken').toBeTypeOf('string')

  return callTool(name, { ...args, confirm: true, confirmToken })
}

const cli = (args: string[], env?: Record<string, string | undefined>): Promise<SpawnedRun> => {
  return runCli({ cliPath, fixture, args, env })
}

beforeAll(async () => {
  const built = await buildMcpBundle('agent-cli-')

  outDir = built.outDir
  mcpPath = built.mcpPath
  cliPath = join(outDir, 'cli.js')
  fixture = makeAgentCliFixture()
  mcp = await connectMcp()
}, 90_000)

afterAll(async () => {
  await Promise.all(
    clients.map((client) => {
      return client.close()
    }),
  )

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

  it("ac2: `worktrees add --versions <v> --yes --agent --json` creates the worktree; structuredContent equals the MCP tool's", async () => {
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

    // Same fixture state for the MCP half: the worktree the CLI just made is unregistered first, so
    // both surfaces perform the same creation rather than one creating and the other skipping.
    removeReleaseWorktree(fixture)

    const viaMcp = await callTool('worktrees-add', { versions: FIXTURE_RELEASE.ref })

    expect(viaMcp.isError).toBeFalsy()
    expect(existsSync(join(fixture.releaseWorktreeDir, 'infra-kit.json'))).toBe(true)
    expect(canonical(json)).toBe(canonical(viaMcp.structuredContent))
  }, 30_000)
})

describe('golden parity: `<cmd> --json --agent` stdout equals the MCP tool structuredContent', () => {
  const cases: { argv: string[]; tool: string; args?: Record<string, unknown> }[] = [
    { argv: ['dev-status'], tool: 'dev-status' },
    { argv: ['release', 'list'], tool: 'gh-release-list' },
    { argv: ['worktrees', 'list'], tool: 'worktrees-list' },
    { argv: ['reopen', '--dry-run'], tool: 'reopen', args: { dryRun: true } },
    { argv: ['env-status'], tool: 'env-status' },
    { argv: ['config-get'], tool: 'config-get' },
    { argv: ['version'], tool: 'version' },
    { argv: ['audit'], tool: 'audit' },
    { argv: ['vendor', 'check'], tool: 'vendor-check' },
  ]

  for (const { argv, tool, args } of cases) {
    it(`${argv.join(' ')} ≡ ${tool}`, async () => {
      ensureReleaseWorktree(fixture)

      const run = await cli([...argv, '--json', '--agent'])
      const json = expectJson(run)
      const viaMcp = await callTool(tool, args)

      expect(viaMcp.isError, `MCP ${tool} errored:\n${textOf(viaMcp)}`).toBeFalsy()
      expect(canonical(json)).toBe(canonical(viaMcp.structuredContent))
    }, 30_000)
  }

  // Reviewer-found HIGH: `-C` used `process.chdir`, which zx ignores (it snapshots its cwd at import),
  // so every `git` call kept running in the launch dir and `version --json` reported `repoRoot: null`.
  // Spawned from a FOREIGN cwd on purpose: an in-process test cannot see a subprocess's cwd.
  it('`-C <fixture>` from a foreign cwd: worktrees list byte-equals the in-repo run, version sees the repo', async () => {
    ensureReleaseWorktree(fixture)

    const foreign = mkdtempSync(join(tmpdir(), 'ik-foreign-cwd-'))

    try {
      const inRepo = await cli(['worktrees', 'list', '--json', '--agent'])
      const viaC = await runCli({
        cliPath,
        fixture,
        cwd: foreign,
        args: ['-C', fixture.repoDir, 'worktrees', 'list', '--json', '--agent'],
      })

      expect(viaC.code, viaC.stderr).toBe(0)
      expect(viaC.stdout).toBe(inRepo.stdout)

      const version = await runCli({
        cliPath,
        fixture,
        cwd: foreign,
        args: ['-C', fixture.repoDir, 'version', '--json'],
      })
      const json = expectJson(version)

      expect(json.cwd).toBe(fixture.repoDir)
      expect(json.repoRoot).toBe(fixture.repoDir)
    } finally {
      rmSync(foreign, { recursive: true, force: true })
    }
  }, 30_000)

  it('env-status reports the fixture session id on both surfaces', async () => {
    const run = await cli(['env-status', '--json', '--agent'])

    expect(expectJson(run).sessionId).toBe(FIXTURE_SESSION)
  })

  // `env-list` enumerates Doppler configs through the `doppler` binary and a project token; there is
  // no fixture for that here, so the pair would only ever compare two "doppler is not installed"
  // failures — which proves nothing about parity.
  it.skip('env-list ≡ env-list — needs a Doppler project and token; no hermetic fixture', () => {
    expect.unreachable('skipped: a Doppler fixture would be needed for a meaningful comparison')
  })
})

describe('form-backed refusal', () => {
  it('ac3: `release remove --agent --json` (no version) → exit 2, argument_required for `version`, choices = the release-remove form rows; MCP returns isError with the same status/argument', async () => {
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

    // Over MCP the form is offered BEFORE the handler, so the handler-level refusal there carries
    // `argument` but not `choices` (`refuse-missing-arguments.ts` is inert under the `'mcp'` source
    // by design), and `agentMode` names the transport. Everything else is the same payload.
    const viaMcp = await callGatedTool('release-remove', {})

    expect(viaMcp.isError).toBe(true)
    expect(viaMcp.structuredContent?.agentMode).toBe('mcp')
    expect(withoutKeys(viaMcp.structuredContent, ['agentMode'])).toStrictEqual(
      withoutKeys(json, ['agentMode', 'choices']),
    )

    // …and the rows an MCP client IS offered are the CLI's `choices`: a form-capable client receives
    // the same JSON Schema as the form's `requestedSchema`, minus `additionalProperties` — the SDK's
    // `inputRequired.elicit` re-renders the schema into the elicitation wire subset (`type`,
    // `properties`, `required`, primitives), which has no way to say it. The rows themselves are
    // untouched; the in-process comparison above already pins `choices` to the builder verbatim.
    const offered: ElicitRequestFormParams[] = []
    const formClient = await connectMcp({ capabilities: { elicitation: { form: {} } } })

    formClient.setRequestHandler('elicitation/create', (request) => {
      offered.push(request.params as ElicitRequestFormParams)

      return { action: 'decline' }
    })

    await formClient.callTool({ name: 'release-remove', arguments: {} }, { timeout: 15_000 })

    expect(offered).toHaveLength(1)
    expect(canonical(offered[0]?.requestedSchema)).toBe(
      canonical(withoutKeys(json.choices as Record<string, unknown>, ['additionalProperties'])),
    )
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
  const MCP_REFUSAL = '"prod" is not reachable over MCP in this project'
  const AGENT_REFUSAL = '"prod" is withheld from agents in this project (protectedEnvs: "cli-only")'

  // `assertDeployable` throws a structured `refused` (exit 2, nothing ran): the payload on stdout
  // under `--json`, the agent-worded message on stderr — never the MCP wording, which is true of one
  // transport only. Returns the exit code so each case's own `expect` carries the verdict.
  const refusalExit = (run: SpawnedRun): number | null => {
    const json = expectJson(run)

    expect(json).toMatchObject({ status: 'refused', env: 'prod' })
    expect(json.agentMode).not.toBeNull()
    expect(run.stderr).toContain(AGENT_REFUSAL)
    expect(run.stderr).not.toContain('over MCP')

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

  it('the MCP transport refuses', async () => {
    const before = dispatches().length
    const viaMcp = await callGatedTool('gh-release-deploy-all', { version: FIXTURE_RELEASE.version, env: 'prod' })

    expect(viaMcp.isError).toBe(true)
    expect(textOf(viaMcp)).toContain(MCP_REFUSAL)
    expect(viaMcp.structuredContent).toMatchObject({ status: 'refused', env: 'prod', agentMode: 'mcp' })
    expect(dispatches()).toHaveLength(before)
  }, 30_000)
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

  it('ac10: `worktrees remove --versions <v> --yes --agent --json` on a dirty worktree → exit 1, partial_failure; MCP returns isError with the same structuredContent', async () => {
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

    const viaMcp = await callGatedTool('worktrees-remove', { versions: FIXTURE_RELEASE.ref })

    expect(viaMcp.isError).toBe(true)
    expect(canonical(viaMcp.structuredContent)).toBe(canonical(json))
  }, 30_000)
})
