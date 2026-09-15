import type { Command } from 'commander'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $, cd } from 'zx'

import { agentMode } from 'src/lib/agent-mode'
import { commandCatalog } from 'src/lib/command-catalog'
import { resolveLeaf } from 'src/lib/command-catalog/palette'
import { commandEcho } from 'src/lib/command-echo'
import { ensureUserProjectConfig } from 'src/lib/config-bootstrap'
import { jsonOutput } from 'src/lib/json-output'

import { buildProgram } from '../program'

/**
 * @fileoverview
 * The preAction hook's agent contract: `-C <dir>` is applied FIRST (before the layer-3 seed, which
 * keys off the cwd), and `agentMode.source` is resolved from `--agent` and the environment on every
 * run that is not already the MCP server's. The seed and the auto-load are mocked for the same
 * reason program.test.ts mocks them — they touch $HOME and Doppler.
 */

const seedCwds: string[] = []

vi.mock('src/lib/config-bootstrap', () => {
  return {
    ensureUserProjectConfig: vi.fn(async () => {
      seedCwds.push(process.cwd())
    }),
  }
})

vi.mock('src/lib/env-autoload', () => {
  return { runEnvAutoLoad: vi.fn(async () => {}), surfaceStickyAuthFailure: vi.fn() }
})

const originalCwd = process.cwd()
const originalEnv = { ...process.env }
let tmp: string

const overrideExitDeep = (cmd: Command): void => {
  cmd.exitOverride()
  cmd.commands.forEach(overrideExitDeep)
}

/** Parse `argv` with the target leaf's action swapped for a no-op, so only the hooks run. */
const parseInert = async (groupPath: string[], extra: string[] = [], leading: string[] = []): Promise<void> => {
  const program = buildProgram()

  overrideExitDeep(program)

  const leaf = resolveLeaf(program.commands, groupPath)!

  leaf.action(() => {})

  await program.parseAsync(['node', 'infra-kit', ...leading, ...groupPath, ...extra])
}

/** A leaf that is NOT in SEED_EXCLUDED, so the seed leg of the hook runs. */
const SEEDING_LEAF = ['worktrees', 'list']

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'ik-agent-contract-')))
  seedCwds.length = 0
  vi.mocked(ensureUserProjectConfig).mockClear()
})

afterEach(() => {
  // zx's cwd is its own state: `process.chdir` alone would leave every later `$` in the launch dir.
  cd(originalCwd)
  rmSync(tmp, { recursive: true, force: true })
  agentMode.source = null
  jsonOutput.enabled = false
  commandEcho.reset()

  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }

  Object.assign(process.env, originalEnv)
})

describe('-C <dir>', () => {
  it('is registered on the root program and listed in --help', () => {
    const program = buildProgram()

    expect(
      program.options.some((option) => {
        return option.short === '-C'
      }),
    ).toBe(true)
    expect(program.helpInformation()).toMatch(/-C <dir>/)
  })

  it('chdirs BEFORE the layer-3 seed runs, so the seed keys off the new cwd', async () => {
    await parseInert(SEEDING_LEAF, [], ['-C', tmp])

    expect(ensureUserProjectConfig).toHaveBeenCalledTimes(1)
    expect(seedCwds).toEqual([tmp])
    expect(process.cwd()).toBe(tmp)
  })

  it('moves zx too: a `$` subprocess after preAction runs in the new dir (zx snapshots its own cwd)', async () => {
    // Reviewer-found: `process.chdir` moved `process.cwd()` and nothing else — every `git` call in the
    // tree kept running in the launch dir, so `-C <repo> version --json` reported `repoRoot: null`.
    await parseInert(SEEDING_LEAF, [], ['-C', tmp])

    expect((await $`pwd`).stdout.trim()).toBe(tmp)
    expect(process.cwd()).toBe(tmp)
  })

  it('resolves a relative dir against the cwd the command was typed in', async () => {
    const parent = path.dirname(tmp)
    const base = path.basename(tmp)

    cd(parent)

    await parseInert(SEEDING_LEAF, [], ['-C', base])

    expect(process.cwd()).toBe(tmp)
    expect(seedCwds).toEqual([tmp])
  })

  it('is accepted after the subcommand as well (git-style global, not positional-only)', async () => {
    await parseInert(SEEDING_LEAF, ['-C', tmp])

    expect(process.cwd()).toBe(tmp)
  })

  it('leaves the cwd alone when not given', async () => {
    await parseInert(SEEDING_LEAF)

    expect(process.cwd()).toBe(originalCwd)
    expect(seedCwds).toEqual([originalCwd])
  })
})

describe('--agent and the environment resolve agentMode.source in preAction', () => {
  const scrub = () => {
    delete process.env.INFRA_KIT_AGENT
    delete process.env.CLAUDECODE
  }

  it('is registered on the root and on every catalog leaf, and listed in --help', () => {
    const program = buildProgram()
    const hasAgent = (cmd: Command): boolean => {
      return cmd.options.some((option) => {
        return option.long === '--agent'
      })
    }
    const everyNode = (cmd: Command): Command[] => {
      return [cmd, ...cmd.commands.flatMap(everyNode)]
    }

    expect(
      everyNode(program)
        .filter((cmd) => {
          return !hasAgent(cmd)
        })
        .map((cmd) => {
          return cmd.name()
        }),
    ).toEqual([])
    expect(program.helpInformation()).toMatch(/--agent/)
  })

  it('accepts --agent on every catalog leaf', async () => {
    scrub()

    for (const entry of commandCatalog) {
      const leaf = resolveLeaf(buildProgram().commands, entry.groupPath)

      if (leaf === undefined || leaf.commands.length > 0) continue

      const required = leaf.registeredArguments
        .filter((argument) => {
          return argument.required
        })
        .map(() => {
          return 'placeholder'
        })

      await expect(parseInert(entry.groupPath, [...required, '--agent'])).resolves.toBeUndefined()
      expect(agentMode.source, entry.groupPath.join(' ')).toBe('flag')
      agentMode.source = null
    }
  })

  it('--agent → flag, even with INFRA_KIT_AGENT=0 in the environment', async () => {
    scrub()
    process.env.INFRA_KIT_AGENT = '0'

    await parseInert(SEEDING_LEAF, ['--agent'])

    expect(agentMode.source).toBe('flag')
  })

  it('iNFRA_KIT_AGENT=1 → env without the flag', async () => {
    scrub()
    process.env.INFRA_KIT_AGENT = '1'

    await parseInert(SEEDING_LEAF)

    expect(agentMode.source).toBe('env')
  })

  it('nothing set → null (a human run), and a stale source from a previous run is cleared', async () => {
    scrub()
    agentMode.source = 'env'

    await parseInert(SEEDING_LEAF)

    expect(agentMode.source).toBeNull()
  })

  it('reads process.stdin.isTTY for the CLAUDECODE heuristic', async () => {
    scrub()
    process.env.CLAUDECODE = '1'

    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

    try {
      await parseInert(SEEDING_LEAF)

      expect(agentMode.source).toBe('env')

      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
      await parseInert(SEEDING_LEAF)

      expect(agentMode.source).toBeNull()
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
    }
  })

  it("never overwrites the MCP server's own 'mcp' source", async () => {
    scrub()
    agentMode.source = 'mcp'

    await parseInert(SEEDING_LEAF, ['--agent'])

    expect(agentMode.source).toBe('mcp')
  })
})
