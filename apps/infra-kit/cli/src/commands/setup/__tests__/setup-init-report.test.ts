import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InitStepName } from 'src/commands/init'
import { setup } from 'src/commands/setup'
import type { ProbeDeps } from 'src/lib/dependency-probe'
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { MARKETPLACE_ADD_COMMAND, PLUGIN_INSTALL_COMMAND } from 'src/lib/plugin-pointer'

import { migrateConfigShapes } from '../../init/migrate-config'

/**
 * What an MCP caller actually receives from the init half — driven through the REAL `initCore`, because
 * the assertion is that the payload carries what the steps did. Against a mocked init half the same
 * assertions would only read back the fixture.
 *
 * `logger` writes to stderr, never to the result payload, so a `setup` tool whose init half reported
 * through it alone performed every local write and told the agent nothing.
 */

vi.mock('../../init/migrate-config', () => {
  return {
    migrateConfigShapes: vi.fn(async () => {}),
    migrateFactoryConfigToJson: vi.fn(async () => {}),
    migrateLegacyConfig: vi.fn(async () => {}),
    migrateUserGlobalConfigFilename: vi.fn(async () => {}),
  }
})

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    getMainRepoRoot: vi.fn(async (cwd?: string) => {
      return cwd
    }),
  }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

/** The one seam that must be faked: the real installer spawns `claude` and would install a plugin. */
vi.mock('src/lib/plugin-pointer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/plugin-pointer')>()

  return {
    ...actual,
    installPluginForProject: vi.fn(() => {
      return { status: 'claude-missing' }
    }),
  }
})

/** Everything absent: the probe has something to report, and nothing is a candidate for a real install. */
const nothingInstalled = (): ProbeDeps => {
  return {
    runCommand: async () => {
      throw new Error('not found')
    },
    resolveBinPath: async () => {
      return null
    },
    realpath: (candidate) => {
      return candidate
    },
    platform: 'darwin',
  }
}

/** A `Record` so adding an `InitStepName` without a row here fails `ts-check`, not silently passes. */
const EVERY_STEP: Record<InitStepName, true> = {
  zshrc: true,
  zshenv: true,
  migrations: true,
  'user-config': true,
  guidance: true,
  'plugin-pointer': true,
  'mcp-server': true,
  'mcp-proxies': true,
  'project-config': true,
  shell: true,
}

let home: string
let repo: string
const originalExitCode = process.exitCode

const infoLines = (): string[] => {
  return vi.mocked(logger.info).mock.calls.map((call) => {
    return typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0])
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.exitCode = undefined

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-report-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-report-repo-'))

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(repo))

  fs.writeFileSync(path.join(repo, 'infra-kit.json'), '{}\n', 'utf-8')
  process.env.INFRA_KIT_NO_SEED = '1'

  resetInfraKitConfigCache()
})

afterEach(() => {
  delete process.env.INFRA_KIT_NO_SEED
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('the MCP payload reports what the init half did', () => {
  // Reds on: reverting `initCore` to `Promise<void>` / logger-only — `init` would arrive empty.
  it('carries one entry per step, with outcomes, for every step that ran', async () => {
    const { structuredContent } = await setup({ probeDeps: nothingInstalled(), skipTools: true })
    const steps = structuredContent.init.map((entry) => {
      return entry.step
    })

    // All ten: a step that did not run this time still reports (`skipped`), and one that ran and
    // changed nothing reports `unchanged` — "nothing happened" is an answer an agent needs, silence is not.
    expect(new Set(steps)).toEqual(new Set(Object.keys(EVERY_STEP)))
    expect(structuredContent.init).toContainEqual({
      step: 'zshrc',
      outcome: 'written',
      message: `Added infra-kit shell functions to ${path.join(home, '.zshrc')}`,
    })
    expect(structuredContent.init).toContainEqual({
      step: 'zshenv',
      outcome: 'written',
      message: `Added infra-kit session-env block to ${path.join(home, '.zshenv')}`,
    })
    expect(structuredContent.init).toContainEqual({
      step: 'user-config',
      outcome: 'written',
      message: expect.stringContaining(path.join(home, '.infra-kit', 'infra-kit.json')) as unknown as string,
    })
    // The steps really ran — the report is a record of writes, not a description of intended ones.
    expect(fs.readFileSync(path.join(home, '.zshrc'), 'utf-8')).toContain('# -- infra-kit:begin --')
    expect(fs.readFileSync(path.join(home, '.zshenv'), 'utf-8')).toContain('# -- infra-kit:begin --')
    // The `mcp-server` step is a read now — the plugin is skills-only — so nothing lands here.
    expect(fs.existsSync(path.join(repo, '.mcp.json'))).toBe(false)
    expect(structuredContent.init).toContainEqual({
      step: 'mcp-server',
      outcome: 'unchanged',
      message: expect.stringContaining('none wanted — the plugin is skills-only') as unknown as string,
    })
  })

  // Reds on: an `initCore` step that stops recording an entry, or a new step name nobody reports.
  it.each(Object.keys(EVERY_STEP))('reports the %s step in a real run', async (step) => {
    const { structuredContent } = await setup({ probeDeps: nothingInstalled(), skipTools: true })

    expect(
      structuredContent.init.some((entry) => {
        return entry.step === step
      }),
    ).toBe(true)
  })

  // Reds on: reporting the migrations step `skipped` again — it ran; its conversions print their own lines.
  it('reports the migrations step as ran, not as skipped', async () => {
    const { structuredContent } = await setup({ probeDeps: nothingInstalled(), skipTools: true })

    expect(structuredContent.init).toContainEqual({
      step: 'migrations',
      outcome: 'unchanged',
      message: expect.stringContaining('Config migrations checked') as unknown as string,
    })
  })

  // Reds on: folding a command handed to a human back into `skipped`, which an agent reads as "nothing to do".
  it('reports the two plugin commands a human runs as manual when claude is missing', async () => {
    const { structuredContent } = await setup({ probeDeps: nothingInstalled(), skipTools: true })

    expect(structuredContent.init).toContainEqual({
      step: 'plugin-pointer',
      outcome: 'manual',
      message: MARKETPLACE_ADD_COMMAND,
    })
    expect(structuredContent.init).toContainEqual({
      step: 'plugin-pointer',
      outcome: 'manual',
      message: PLUGIN_INSTALL_COMMAND,
    })
  })

  // Reds on: recording an init throw as `warned`, the word a non-fatal failure that exits 0 also uses.
  it('reports an init throw as failed, and exits 1', async () => {
    vi.mocked(migrateConfigShapes).mockRejectedValueOnce(new Error('EACCES: read-only file system'))

    const { structuredContent } = await setup({ probeDeps: nothingInstalled(), skipTools: true })

    expect(structuredContent.init.at(-1)).toEqual({
      step: 'migrations',
      outcome: 'failed',
      message: 'The migrations step failed: EACCES: read-only file system',
    })
    expect(process.exitCode).toBe(1)
  })

  // Reds on: letting a per-file guidance failure turn the run red, or reporting it as `failed`.
  it('reports a guidance write failure as warned, and exits 0', async () => {
    // A directory where the root CLAUDE.md belongs: the guidance writer cannot read or replace it.
    fs.mkdirSync(path.join(repo, 'CLAUDE.md'))

    const { structuredContent } = await setup({ probeDeps: nothingInstalled(), skipTools: true })
    const guidance = structuredContent.init.filter((entry) => {
      return entry.step === 'guidance'
    })

    expect(guidance).toContainEqual({
      step: 'guidance',
      outcome: 'warned',
      message: expect.stringContaining('could not be written') as unknown as string,
    })
    expect(
      structuredContent.init.some((entry) => {
        return entry.outcome === 'failed'
      }),
    ).toBe(false)
    expect(process.exitCode ?? 0).toBe(0)
  })

  // Reds on: returning the internal entries verbatim, which would leak the CLI's `level` rendering hint
  // into a payload whose schema does not declare it.
  it('carries exactly the three declared keys per entry', async () => {
    const { structuredContent } = await setup({ probeDeps: nothingInstalled(), skipTools: true })

    for (const entry of structuredContent.init) {
      expect(Object.keys(entry).sort()).toEqual(['message', 'outcome', 'step'])
    }
  })

  // Reds on: printing the init half's entries in a trailing block, or dropping the held-back reminder —
  // the human output must read init half, then tools, then how to activate.
  it('prints the init half first, the tool summary next, and the activation reminder last', async () => {
    await setup({ probeDeps: nothingInstalled(), skipTools: true })

    const lines = infoLines()
    const zshrc = lines.findIndex((line) => {
      return line.startsWith('Added infra-kit shell functions')
    })
    const tools = lines.findIndex((line) => {
      return line.includes('doppler —')
    })

    expect(zshrc).toBeGreaterThanOrEqual(0)
    expect(zshrc).toBeLessThan(tools)
    expect(lines.at(-1)).toBe('Run `source ~/.zshrc` or open a new terminal to activate.')
    // Exactly once: held back from the init half's stream, not printed there AND here.
    expect(
      lines.filter((line) => {
        return line.startsWith('Run `source ~/.zshrc`')
      }),
    ).toHaveLength(1)
  })
})
