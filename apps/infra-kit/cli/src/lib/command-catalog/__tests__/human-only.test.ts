import type { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchOpenPRsByHead } from 'src/integrations/gh'
import { agentMode } from 'src/lib/agent-mode'
import { commandCatalog } from 'src/lib/command-catalog'
import { commandEcho } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { assertManagementContext } from 'src/lib/git-guard'
import { jsonOutput } from 'src/lib/json-output'
import { buildProgram } from 'src/lib/program'

/**
 * `humanOnly` promises a refusal under agent mode that `--yes` cannot lift. Every row carrying it runs
 * through the real Commander program with `--agent --yes`, and the assertion is on the refusal payload,
 * not on exit 2: `release deliver` without a version also exits 2, through `argument_required`, which
 * would pass an exit-code check for the wrong reason.
 */

vi.mock('src/lib/config-bootstrap', () => {
  return { ensureUserProjectConfig: vi.fn() }
})

vi.mock('src/integrations/gh', () => {
  return {
    fetchOpenPRsByHead: vi.fn(),
    fetchPRByHead: vi.fn(),
    fetchPRByNumber: vi.fn(),
    getReleasePRsWithInfo: vi.fn(),
  }
})

vi.mock('src/lib/git-guard', () => {
  return { assertManagementContext: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

/** Arguments a row needs to get past argument resolution and reach its agent check. */
const ARGS_PAST_RESOLUTION: Record<string, string[]> = {
  'release-deliver': ['--version', '1.2.5'],
}

const HUMAN_ONLY_REASON = /refused in agent mode regardless of --yes/

const overrideExitDeep = (cmd: Command): void => {
  cmd.exitOverride()
  cmd.commands.forEach(overrideExitDeep)
}

const runAgentYes = async (groupPath: string[], args: string[]): Promise<unknown> => {
  const program = buildProgram()

  overrideExitDeep(program)

  return program.parseAsync(['node', 'infra-kit', ...groupPath, ...args, '--agent', '--yes']).catch((e: unknown) => {
    return e
  })
}

const humanOnlyRows = commandCatalog.filter((entry) => {
  return entry.humanOnly
})

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  vi.mocked(assertManagementContext).mockResolvedValue(undefined)
  vi.mocked(fetchOpenPRsByHead).mockResolvedValue([
    { number: 42, state: 'OPEN', title: 'Release v1.2.5', baseRefName: 'dev', headRefName: 'release/v1.2.5' },
  ])
})

afterEach(() => {
  agentMode.source = null
  jsonOutput.enabled = false
})

describe('humanOnly catalog rows refuse --agent --yes', () => {
  it('covers at least release deliver and vendor sync', () => {
    expect(
      humanOnlyRows.map((entry) => {
        return entry.cliName
      }),
    ).toEqual(expect.arrayContaining(['release-deliver', 'vendor-sync']))
  })

  it.each(
    humanOnlyRows.map((entry) => {
      return [entry.groupPath.join(' '), entry] as const
    }),
  )('%s refuses with status refused and the human-only reason', async (_label, entry) => {
    const error = await runAgentYes(entry.groupPath, ARGS_PAST_RESOLUTION[entry.cliName] ?? [])

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({ status: 'refused', agentMode: 'flag' })
    expect((error as StructuredRefusalError).stderrExcerpt).toMatch(HUMAN_ONLY_REASON)
    expect((error as StructuredRefusalError).remediation).toContain('ask a human to run')
  })
})

describe('the plugin skills never name vendor sync', () => {
  const SKILLS_DIR = path.resolve(import.meta.dirname, '../../../../../../..', 'plugins', 'infra-kit', 'skills')

  const skillFiles = (dir: string): string[] => {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) return skillFiles(full)

      return entry.name === 'SKILL.md' ? [full] : []
    })
  }

  it('finds skills to scan', () => {
    expect(skillFiles(SKILLS_DIR).length).toBeGreaterThan(0)
  })

  it('no SKILL.md contains "vendor sync"', () => {
    const hits = skillFiles(SKILLS_DIR).filter((file) => {
      return fs.readFileSync(file, 'utf8').includes('vendor sync')
    })

    expect(hits).toEqual([])
  })
})
