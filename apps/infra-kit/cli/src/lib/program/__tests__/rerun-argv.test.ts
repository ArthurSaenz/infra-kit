import type { Command } from 'commander'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cd } from 'zx'

import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { jsonOutput } from 'src/lib/json-output'
import { rerunArgv, setParsedArgv } from 'src/lib/parsed-argv'

import { buildProgram } from '../program'

/**
 * @fileoverview
 * `rerunArgv()` is what a `confirmation_required` refusal hands an agent to run next, so it has to be
 * an argv Commander parses back to the SAME invocation plus `yes: true`. Pinned by parsing both the
 * refused argv and its re-run through a fresh program and comparing what the leaf received —
 * `optsWithGlobals()` and the positional arguments — rather than by reading the array.
 */

vi.mock('src/lib/config-bootstrap', () => {
  return { ensureUserProjectConfig: vi.fn(async () => {}) }
})

vi.mock('src/lib/env-autoload', () => {
  return { runEnvAutoLoad: vi.fn(async () => {}), surfaceStickyAuthFailure: vi.fn() }
})

const originalCwd = process.cwd()
const originalEnv = { ...process.env }
let tmp: string

interface Parsed {
  opts: Record<string, unknown>
  args: unknown[]
}

const overrideExitDeep = (cmd: Command): void => {
  cmd.exitOverride()
  cmd.commands.forEach(overrideExitDeep)
}

/** Parse `userArgs` against a fresh program whose target leaf records what it was handed. */
const parseLeaf = async (groupPath: string[], userArgs: string[]): Promise<Parsed> => {
  const program = buildProgram()

  overrideExitDeep(program)

  let parsed: Parsed | null = null
  const leaf = groupPath.reduce<Command>((node, name) => {
    return node.commands.find((candidate) => {
      return candidate.name() === name
    })!
  }, program)

  leaf.action((...actionArgs: unknown[]) => {
    const command = actionArgs.at(-1) as Command

    parsed = { opts: command.optsWithGlobals(), args: command.args }
  })

  await program.parseAsync(['node', 'infra-kit', ...userArgs])

  return parsed!
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'ik-rerun-argv-')))
  delete process.env.INFRA_KIT_AGENT
  delete process.env.CLAUDECODE
})

afterEach(() => {
  // `-C` now goes through zx's `cd`, so the restore must too, or zx keeps the test's tmp dir.
  cd(originalCwd)
  rmSync(tmp, { recursive: true, force: true })
  agentMode.source = null
  jsonOutput.enabled = false
  commandEcho.reset()
  Object.assign(process.env, originalEnv)
})

describe('rerunArgv round-trips through the program', () => {
  it.each([
    {
      label: 'grouped leaf with flags',
      path: ['release', 'remove'],
      argv: ['release', 'remove', '--version', '1.2.3', '--agent', '--json'],
    },
    {
      label: 'string options with spaces in their values',
      path: ['release', 'desc-edit'],
      argv: ['release', 'desc-edit', '--version', '1.2.3', '--description', 'x y'],
    },
    {
      label: 'a variadic option (--services <services...>) stops at --yes',
      path: ['release', 'deploy-selected'],
      argv: ['release', 'deploy-selected', '--from', 'ci', '--services', 'api', 'ui', '--agent'],
    },
    {
      label: 'absolute -C is kept',
      path: ['worktrees', 'sync'],
      argv: ['-C', '/tmp', 'worktrees', 'sync', '--json'],
    },
  ])('$label', async ({ path: groupPath, argv }) => {
    setParsedArgv(['node', 'infra-kit', ...argv])

    const refused = await parseLeaf(groupPath, argv)
    const rerun = rerunArgv()
    const confirmed = await parseLeaf(groupPath, rerun)

    expect(rerun.at(-1)).toBe('--yes')
    expect(confirmed.args).toEqual(refused.args)
    expect(confirmed.opts).toEqual({ ...refused.opts, yes: true })
  })

  it('a relative -C becomes absolute against the launch cwd, so the re-run parses from anywhere', async () => {
    const parent = path.dirname(tmp)
    const base = path.basename(tmp)

    process.chdir(parent)
    setParsedArgv(['node', 'infra-kit', '-C', base, 'worktrees', 'sync', '--json'])

    const refused = await parseLeaf(['worktrees', 'sync'], ['-C', base, 'worktrees', 'sync', '--json'])

    expect(process.cwd()).toBe(tmp)

    const rerun = rerunArgv()

    expect(rerun).toEqual(['-C', tmp, 'worktrees', 'sync', '--json', '--yes'])

    // From a DIFFERENT cwd — the point of absolutizing.
    process.chdir(originalCwd)

    const confirmed = await parseLeaf(['worktrees', 'sync'], rerun)

    expect(process.cwd()).toBe(tmp)
    expect(confirmed.opts).toEqual({ ...refused.opts, C: tmp, yes: true })
  })
})
