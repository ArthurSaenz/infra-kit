import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import {
  MARKETPLACE_ADD_COMMAND,
  MARKETPLACE_NAME,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_KEY,
  PLUGIN_UPDATE_ARGV,
  PLUGIN_UPDATE_COMMAND,
  installPluginForProject,
} from 'src/lib/plugin-pointer'
import type { ClaudeCommand, ClaudeRunner } from 'src/lib/plugin-pointer'
import { fetchLatestVersion } from 'src/lib/update-check'
import type { UpdateCache } from 'src/lib/update-check'

import packageJson from '../../../../package.json' with { type: 'json' }
import { initCore, logInitEntry } from '../init'

/**
 * The additive half's plugin steps — the pointer, the install and the `.mcp.json` registration —
 * exercised through the real `initCore` rather than the libs.
 *
 * Each lib's own suite proves its merge; what can only be proved here is the WIRING: that the steps
 * run, that all three target the ONE root `resolveGitRoot` produced (not the cwd, and no longer the
 * guidance step's `infra-kit.json`-gated root), that the two gates announce themselves separately
 * when they disagree, and that no failure below turns a machine-setup command red.
 */

vi.mock('../migrate-config', () => {
  return {
    migrateFactoryConfigToJson: vi.fn(async () => {}),
    migrateLegacyConfig: vi.fn(async () => {}),
    migrateUserGlobalConfigFilename: vi.fn(async () => {}),
    normalizeLegacyIdeStructures: vi.fn(async () => {}),
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

/**
 * The registry fetch behind the stale-CLI gate, and nothing else in `update-check`: the cache read
 * stays real (it targets the temp `$XDG_CACHE_HOME` below), so the gate's cache-present cases go
 * through the same file the update worker writes. Rejecting by default makes an unexpected fetch loud.
 */
vi.mock('src/lib/update-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/update-check')>()

  return {
    ...actual,
    fetchLatestVersion: vi.fn(async () => {
      throw new Error('fetchLatestVersion called without a stub')
    }),
  }
})

/**
 * The ONE seam this suite fakes, and it must be faked: the real installer spawns `claude`, so on a
 * developer's machine an unmocked run would install a plugin as a side effect of running the tests.
 * Everything else in `src/lib/plugin-pointer` stays real — the pointer merge is what several cases
 * below assert, and a wholesale module mock would make them prove nothing.
 *
 * Its default behaviour mirrors the real installer's two host-state branches: `updated` when the host
 * state says the plugin is installed here (read through the module's OWN resolver, so the fake cannot
 * disagree with the fixtures — the real installer would run `claude plugin update` and report the
 * same), `claude-missing` otherwise, the honest answer for a machine with no `claude` binary.
 */
vi.mock('src/lib/plugin-pointer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/plugin-pointer')>()

  return {
    ...actual,
    installPluginForProject: vi.fn((options: { projectRoot: string }) => {
      const installed = actual.resolvePluginInstall({ projectPath: options.projectRoot }).kind === 'installed'

      return installed ? { status: 'updated' } : { status: 'claude-missing' }
    }),
  }
})

let home: string
let repo: string

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
}

const infoLines = (): string[] => {
  return vi.mocked(logger.info).mock.calls.map((call) => {
    return typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0])
  })
}

const settingsPath = (): string => {
  return path.join(repo, '.claude', 'settings.json')
}

const readSettings = (): Record<string, Record<string, unknown>> => {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Record<string, Record<string, unknown>>
}

const mcpPath = (): string => {
  return path.join(repo, '.mcp.json')
}

const readMcp = (): Record<string, Record<string, unknown>> => {
  return JSON.parse(fs.readFileSync(mcpPath(), 'utf-8')) as Record<string, Record<string, unknown>>
}

const warnLines = (): string[] => {
  return vi.mocked(logger.warn).mock.calls.map((call) => {
    return typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0])
  })
}

const linesMatching = (pattern: RegExp): string[] => {
  return infoLines().filter((line) => {
    return pattern.test(line)
  })
}

/**
 * The skip that covers all four gated steps. Logged EXACTLY ONCE per run, by `initCore`'s own
 * `resolveGitRootForWrites` call: the shared predicate is silent (`doctor` reads it too), so the
 * guidance gate's delegation to it announces nothing and cannot duplicate the line.
 */
const GIT_ROOT_SKIP = /^Skipped agent-instruction files, the plugin pointer, the plugin install and \.mcp\.json —/

/** The guidance-only skip: this `null` stops the guidance files alone, and says so. */
const GUIDANCE_ONLY_SKIP = /^Skipped agent-instruction files — no infra-kit\.json at the repo root/

/**
 * The additive half on its own: `initCore` with the CLI's entry logger, which is exactly what
 * `infra-kit setup --skip-tools` runs (setup wraps the same sink only to hold its closing
 * shell-activation line back until after the dependency half). The standalone `init` command this
 * suite used to drive no longer exists, so the pairing IS the subject now.
 */
const runInit = async (): Promise<void> => {
  await initCore(logInitEntry)
}

beforeEach(() => {
  vi.clearAllMocks()

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'init-pointer-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'init-pointer-repo-'))

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(repo))

  writeFile(path.join(repo, 'infra-kit.json'), '{}\n')
  process.env.INFRA_KIT_NO_SEED = '1'
  // The update cache lives under the cache root; pin it inside the temp home so no case reads the
  // developer's own `update-check.json` and passes or fails on what their last worker run wrote.
  process.env.XDG_CACHE_HOME = path.join(home, '.cache')

  resetInfraKitConfigCache()
})

afterEach(() => {
  delete process.env.INFRA_KIT_NO_SEED
  delete process.env.XDG_CACHE_HOME
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('setup --skip-tools — plugin pointer', () => {
  it('creates .claude/settings.json at the repo root with both keys', async () => {
    await runInit()

    const settings = readSettings()

    expect(settings.enabledPlugins?.[PLUGIN_KEY]).toBe(true)
    expect(settings.extraKnownMarketplaces?.['infra-kit']).toEqual({
      source: { source: 'github', repo: 'ArthurSaenz/infra-kit' },
    })
  })

  it('merges into an existing settings file without disturbing it', async () => {
    writeFile(
      settingsPath(),
      '{\n  "permissions": {\n    "deny": ["Bash(rm:*)"]\n  },\n  "enabledPlugins": {\n    "omc@omc": true\n  }\n}\n',
    )

    await runInit()

    const settings = readSettings()

    expect(settings.permissions?.deny).toEqual(['Bash(rm:*)'])
    expect(Object.keys(settings.enabledPlugins ?? {})).toEqual(['omc@omc', PLUGIN_KEY])
  })

  it('prints the install command verbatim when the plugin is not installed', async () => {
    await runInit()

    expect(infoLines()).toContain(PLUGIN_INSTALL_COMMAND)
  })

  it('says nothing about installing when the plugin is already installed', async () => {
    writeFile(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { [PLUGIN_KEY]: [{ scope: 'project', projectPath: repo, installPath: null, version: '0.4.0' }] },
      }),
    )

    await runInit()

    expect(infoLines()).not.toContain(PLUGIN_INSTALL_COMMAND)
    expect(
      infoLines().some((line) => {
        return line.includes('claude plugin install')
      }),
    ).toBe(false)
  })

  it('still prints the command when the plugin is installed only for another project', async () => {
    writeFile(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          [PLUGIN_KEY]: [
            { scope: 'project', projectPath: '/Users/someone/other-repo', installPath: null, version: '0.1.0' },
          ],
        },
      }),
    )

    await runInit()

    expect(infoLines()).toContain(PLUGIN_INSTALL_COMMAND)
  })

  it('is idempotent: a second init leaves the file byte-identical', async () => {
    await runInit()

    const first = fs.readFileSync(settingsPath(), 'utf-8')

    await runInit()

    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(first)
  })

  it('prints the marketplace command alongside the install command when claude is missing', async () => {
    await runInit()

    expect(infoLines()).toContain(MARKETPLACE_ADD_COMMAND)
    expect(infoLines().indexOf(MARKETPLACE_ADD_COMMAND)).toBeLessThan(infoLines().indexOf(PLUGIN_INSTALL_COMMAND))
  })

  it('writes no .claude directory when no git root resolves', async () => {
    // Replaces "outside an infra-kit repo": after the gate split a missing `infra-kit.json` no
    // longer stops the pointer (see the gate-split suite below), so the only state that does is a
    // root the git gate refuses.
    vi.mocked(getProjectRoot).mockRejectedValue(new Error('not a git repository'))

    await runInit()

    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false)
  })
})

/**
 * The gate split (criteria 2.1, 2.3, 2.4, 2.8).
 *
 * The guidance writers stay gated on `resolveInfraKitRoot` (`infra-kit.json` present, because their
 * content is config-derived); the pointer, the install and the `.mcp.json` writer are gated on
 * `resolveGitRoot` alone, since none of the three reads that file. What is asserted here is the
 * behaviour a reader of `initCore`'s output depends on: which steps ran, which announced that they did
 * not, and — in the one state where the two gates disagree — the warn that is the only protection
 * standing between a mistargeted run and three tracked files in a stranger's repo.
 */
describe('setup --skip-tools — the gate split', () => {
  it('2.1: emits the four-step skip exactly once and writes nothing in a non-git directory', async () => {
    vi.mocked(getProjectRoot).mockRejectedValue(new Error('not a git repository'))

    await expect(runInit()).resolves.toBeUndefined()

    // EXACTLY one line, and the exactness is the load-bearing half: `1` forbids the duplicate the
    // announcing predicate used to emit (once per gate that refused) AND the fail-open where the
    // announcement is dropped everywhere, which is the state US-001 exists to prevent. The one line
    // names the guidance step AND the pointer/install/.mcp.json steps, so a single line is still a
    // complete record of all four.
    const skips = linesMatching(GIT_ROOT_SKIP)

    expect(skips).toHaveLength(1)
    expect(skips[0]).toContain('agent-instruction files')
    expect(skips[0]).toContain('the plugin pointer, the plugin install and .mcp.json')
    expect(fs.existsSync(settingsPath())).toBe(false)
    expect(fs.existsSync(mcpPath())).toBe(false)
  })

  it('2.3: sets up the plugin steps in a git repo with no infra-kit.json, guidance skipped', async () => {
    fs.rmSync(path.join(repo, 'infra-kit.json'))
    resetInfraKitConfigCache()

    await expect(runInit()).resolves.toBeUndefined()

    expect(linesMatching(GUIDANCE_ONLY_SKIP)).toHaveLength(1)
    expect(linesMatching(GIT_ROOT_SKIP)).toHaveLength(0)
    expect(readSettings().enabledPlugins?.[PLUGIN_KEY]).toBe(true)
    // The plugin serves the MCP server: no `.mcp.json` is written for it any more.
    expect(fs.existsSync(mcpPath())).toBe(false)
    expect(vi.mocked(installPluginForProject)).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: repo }))
  })

  it('2.3: warns exactly once, naming the absolute root and the files it touches', async () => {
    fs.rmSync(path.join(repo, 'infra-kit.json'))
    resetInfraKitConfigCache()

    await runInit()

    // Filtered on the root rather than taken as the only warn: `initCore` legitimately warns about a
    // non-zsh $SHELL on some machines, and that line says nothing about this repo.
    const warnings = warnLines().filter((line) => {
      return line.includes(repo)
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('No infra-kit.json at')
    expect(warnings[0]).toContain('.claude/settings.json')
    expect(warnings[0]).not.toContain('.mcp.json')
    expect(warnings[0]).toContain(PLUGIN_KEY)
    // The absolute path, not "this repo": the failure mode is a caller who is somewhere else than
    // they think, and a relative name would read as correct wherever they are.
    expect(path.isAbsolute(repo)).toBe(true)
  })

  it('2.4: writes nothing when the resolved toplevel is $HOME', async () => {
    vi.mocked(getProjectRoot).mockResolvedValue(home)

    // Evidence that this exercises the $HOME branch and not the blank one: the seam answers a
    // non-empty absolute path that EQUALS os.homedir(). With the prevailing `stdout: ''` zx idiom
    // the blank branch would refuse first and this test would pass for the wrong reason — which is
    // why 2.8 below keeps the blank case separate.
    const stubbed = await vi.mocked(getProjectRoot)()

    expect(stubbed).toBe(os.homedir())
    expect(stubbed).not.toBe('')

    await expect(runInit()).resolves.toBeUndefined()

    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.mcp.json'))).toBe(false)
    expect(fs.existsSync(settingsPath())).toBe(false)
    expect(fs.existsSync(mcpPath())).toBe(false)
    expect(linesMatching(GIT_ROOT_SKIP)).toHaveLength(1)
  })

  it('2.8: treats blank git stdout as a failed resolve and writes no cwd-relative files', async () => {
    // `getProjectRoot` is `result.stdout.trim()` and rejects only when the shell-out itself fails,
    // so blank stdout RESOLVES as ''. Every `path.join('', x)` targets the cwd, so the cwd is moved
    // to an empty directory: a regression writes `.mcp.json` / `.claude/settings.json` HERE.
    const cwdBefore = process.cwd()
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'init-pointer-cwd-'))

    vi.mocked(getProjectRoot).mockResolvedValue('')
    process.chdir(elsewhere)

    try {
      await expect(runInit()).resolves.toBeUndefined()

      expect(fs.readdirSync(elsewhere)).toEqual([])
    } finally {
      process.chdir(cwdBefore)
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }

    expect(fs.existsSync(settingsPath())).toBe(false)
    expect(fs.existsSync(mcpPath())).toBe(false)
    expect(linesMatching(GIT_ROOT_SKIP)).toHaveLength(1)
  })
})

/**
 * The `.mcp.json` step is a READ (plan docs/mcp-via-plugin-migration-plan.md §3.3, `setup`): the plugin
 * serves the MCP server, so `setup` reports what the repo's own file says and writes nothing in any
 * branch. Byte and mtime assertions, because the retired writer used to ADD the key here — and on a
 * repo that had deliberately deleted it, re-adding it is a dirty tracked file and a silent flip back to
 * the legacy route (§4 PM-9).
 */
describe('setup --skip-tools — the MCP registration is read-only', () => {
  const SIBLING_ONLY = `{\n  "mcpServers": {\n    "linear-server": { "type": "http", "url": "https://mcp.linear.app/mcp" }\n  }\n}\n`
  const WITH_KEY = `{\n  "mcpServers": {\n    "infra-kit": { "type": "stdio", "command": "infra-kit", "args": ["mcp"] },\n    "linear-server": { "type": "http", "url": "https://mcp.linear.app/mcp" }\n  }\n}\n`

  const writeAged = (content: string): number => {
    writeFile(mcpPath(), content)

    const aged = new Date(Date.now() - 60_000)

    fs.utimesSync(mcpPath(), aged, aged)

    return fs.statSync(mcpPath()).mtimeMs
  }

  it('leaves a sibling-only .mcp.json byte-identical and reports the server as served by the plugin', async () => {
    const mtime = writeAged(SIBLING_ONLY)

    await runInit()

    expect(fs.readFileSync(mcpPath(), 'utf-8')).toBe(SIBLING_ONLY)
    expect(fs.statSync(mcpPath()).mtimeMs).toBe(mtime)
    expect(linesMatching(/served by the Claude Code plugin/)).toHaveLength(1)
    expect(linesMatching(/created\s+\.mcp\.json|added the infra-kit MCP server/)).toHaveLength(0)
  })

  it('leaves a leftover infra-kit key byte-identical and prints the advisory, at info, once', async () => {
    const mtime = writeAged(WITH_KEY)

    await runInit()

    expect(fs.readFileSync(mcpPath(), 'utf-8')).toBe(WITH_KEY)
    expect(fs.statSync(mcpPath()).mtimeMs).toBe(mtime)

    const advisories = linesMatching(/still registers the "infra-kit" MCP server/)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]).toContain('shadows the plugin')
    expect(advisories[0]).toContain('nothing to fix on this machine')
    expect(advisories[0]).toContain('delete the "infra-kit" entry from .mcp.json by hand')
    expect(
      warnLines().filter((line) => {
        return line.includes('.mcp.json')
      }),
    ).toHaveLength(0)
  })

  it('creates no .mcp.json when there is none (AC-6)', async () => {
    await runInit()

    expect(fs.existsSync(mcpPath())).toBe(false)
    expect(linesMatching(/served by the Claude Code plugin/)).toHaveLength(1)
  })

  it('warns, naming the key, on our server filed under another key', async () => {
    writeAged(`{\n  "mcpServers": {\n    "ik": { "type": "stdio", "command": "infra-kit", "args": ["mcp"] }\n  }\n}\n`)

    await runInit()

    const warnings = warnLines().filter((line) => {
      return line.includes('"ik"')
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('second server process')
  })

  it('reads AFTER the plugin install, so the verdict is about the server the install just put here', async () => {
    writeAged(WITH_KEY)

    const order: string[] = []

    vi.mocked(installPluginForProject).mockImplementationOnce(() => {
      order.push('install')

      return { status: 'claude-missing' }
    })
    vi.mocked(logger.info).mockImplementation((message: unknown) => {
      if (typeof message === 'string' && message.includes('still registers')) order.push('mcp-read')
    })

    await runInit()

    expect(order).toEqual(['install', 'mcp-read'])
  })

  it('1.8: warns once and still exits 0 when .mcp.json is a directory', async () => {
    fs.mkdirSync(mcpPath())

    await expect(runInit()).resolves.toBeUndefined()

    const warnings = warnLines().filter((line) => {
      return line.includes(mcpPath())
    })

    expect(warnings).toHaveLength(1)
    // The steps before it still ran: an unreadable file is not a reason to abandon the rest.
    expect(readSettings().enabledPlugins?.[PLUGIN_KEY]).toBe(true)
  })

  it('1.8: warns once — not at debug — when a plugin step throws on an unwritable root', async () => {
    // A real EACCES rather than a stubbed throw: the pointer's `mkdirSync` is what fails on a
    // read-only repo, and `initCore`'s catch used to swallow it at `debug` while printing its success
    // line. Restoring the mode is in a `finally` so the tmpdir stays removable.
    fs.chmodSync(repo, 0o500)

    try {
      await expect(runInit()).resolves.toBeUndefined()
    } finally {
      fs.chmodSync(repo, 0o700)
    }

    const warnings = warnLines().filter((line) => {
      return line.includes('Could not finish the Claude Code plugin step')
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(repo)
    expect(fs.existsSync(settingsPath())).toBe(false)
  })
})

/**
 * Additivity, asserted per writer (criterion 2.7).
 *
 * `initCore` drives three file writers, and every one of them lands in a file a consumer maintains by
 * hand. This is the property that makes running it in an already-configured repo safe, so it is
 * pinned once per writer here rather than left to each lib's suite.
 */
describe('setup --skip-tools — additivity per writer', () => {
  it('2.7: never overwrites an existing value in .claude/settings.json', async () => {
    // `false` there is a deliberate per-machine opt-out, and a custom marketplace source is a
    // deliberate fork — flipping either would be `initCore` overruling the user.
    writeFile(
      settingsPath(),
      `{\n  "extraKnownMarketplaces": {\n    "infra-kit": { "source": { "source": "github", "repo": "me/fork" } }\n  },\n  "enabledPlugins": {\n    "${PLUGIN_KEY}": false\n  }\n}\n`,
    )

    await runInit()

    const settings = readSettings()

    expect(settings.enabledPlugins?.[PLUGIN_KEY]).toBe(false)
    expect(settings.extraKnownMarketplaces?.['infra-kit']).toEqual({
      source: { source: 'github', repo: 'me/fork' },
    })
  })

  it('2.7: never overwrites an existing entry or sibling in .mcp.json', async () => {
    writeFile(
      mcpPath(),
      `{\n  "mcpServers": {\n    "linear-server": { "type": "http", "url": "https://mcp.linear.app/mcp" },\n    "${MARKETPLACE_NAME}": { "type": "stdio", "command": "/custom/infra-kit", "args": ["mcp"] }\n  }\n}\n`,
    )

    const before = fs.readFileSync(mcpPath(), 'utf-8')

    await runInit()

    // A read, not a write: the bytes — key order and the user's own command included — are untouched.
    expect(fs.readFileSync(mcpPath(), 'utf-8')).toBe(before)
  })

  it('2.7: never overwrites hand-authored content in CLAUDE.md', async () => {
    writeFile(path.join(repo, 'CLAUDE.md'), '# House rules\n\nNever touch this line.\n')

    await runInit()

    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8')).toContain('Never touch this line.')
  })
})

/**
 * The install step's WIRING. What the installer itself does is proved against an injected runner in
 * `lib/plugin-pointer/__tests__/install-plugin.test.ts`; what only `initCore` can prove is that the step
 * runs at all, that it is aimed at the resolved repo root rather than the cwd, and that each outcome
 * reaches the user as one readable line.
 */
describe('setup --skip-tools — plugin install', () => {
  const installMock = vi.mocked(installPluginForProject)

  it('installs the plugin for the resolved repo root', async () => {
    await runInit()

    expect(installMock).toHaveBeenCalledTimes(1)
    expect(installMock).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: repo }))
  })

  it('reports a successful install on one INFO line', async () => {
    installMock.mockReturnValue({ status: 'installed' })

    await runInit()

    expect(infoLines()).toContain(`installed Claude Code plugin ${PLUGIN_KEY} (project scope)`)
  })

  it('reports an installed plugin as up to date on one INFO line, never as a fresh install', async () => {
    // On a configured machine the installer ran `claude plugin update`, not `plugin install`; the line
    // says so, and the install command must not be offered — there is nothing left to install.
    installMock.mockReturnValue({ status: 'updated' })

    await runInit()

    expect(infoLines()).toContain(`Claude Code plugin ${PLUGIN_KEY} up to date (project scope)`)
    expect(
      infoLines().some((line) => {
        return line.includes('installed Claude Code plugin') || line.includes('claude plugin install')
      }),
    ).toBe(false)
  })

  it('warns with the error first line and the manual update command when the update fails', async () => {
    installMock.mockReturnValue({ status: 'update-failed', error: 'Plugin infra-kit is not installed at scope user' })

    await runInit()

    const warning = warnLines().find((line) => {
      return line.includes('Could not update the Claude Code plugin')
    })

    expect(warning).toContain('Plugin infra-kit is not installed at scope user')
    expect(warning).toContain(PLUGIN_UPDATE_COMMAND)
    expect(
      infoLines().some((line) => {
        return line.includes('up to date')
      }),
    ).toBe(false)
  })

  it('warns with the step and the error first line when a step fails', async () => {
    installMock.mockReturnValue({ status: 'failed', step: 'marketplace', error: 'could not read from remote' })

    await runInit()

    const warning = warnLines().find((line) => {
      return line.includes('Could not install the Claude Code plugin')
    })

    expect(warning).toContain('marketplace')
    expect(warning).toContain('could not read from remote')
    expect(warning).toContain(PLUGIN_INSTALL_COMMAND)
  })

  it('warns rather than claiming success when Claude Code recorded no installation', async () => {
    installMock.mockReturnValue({ status: 'unverified' })

    await runInit()

    expect(
      warnLines().some((line) => {
        return line.includes('recorded no installation')
      }),
    ).toBe(true)
    expect(
      infoLines().some((line) => {
        return line.includes('installed Claude Code plugin')
      }),
    ).toBe(false)
  })

  /** A thrown installer must not turn a machine-setup command red, nor stop the steps after it. */
  it('survives an installer that throws', async () => {
    installMock.mockImplementation(() => {
      throw new Error('spawn EPERM')
    })

    await expect(runInit()).resolves.toBeUndefined()
    expect(readSettings().enabledPlugins?.[PLUGIN_KEY]).toBe(true)
  })
})

/**
 * The stale-CLI gate on the update path (PM-9): `setup` must not advance the plugin past a CLI this
 * machine has not received, by the same predicate the update worker applies before its own plugin
 * step. Driven through the REAL installer (restored behind the module mock, with a recording runner)
 * so "no plugin spawn" is the runner's call list, not a mock's return value.
 */
describe('setup --skip-tools — plugin update withheld behind a stale CLI', () => {
  const installMock = vi.mocked(installPluginForProject)
  const fetchMock = vi.mocked(fetchLatestVersion)
  const CURRENT = packageJson.version
  // One major up: newer than whatever this checkout is, and a final release, so a prerelease
  // ordering rule can never turn this fixture into "not newer" on some future version string.
  const NEWER = `${Number(CURRENT.split('.')[0]) + 1}.0.0`

  let calls: ClaudeCommand[]

  const recordingRunner: ClaudeRunner = (command) => {
    calls.push(command)

    return { ok: true }
  }

  const writeInstalledRecord = (): void => {
    writeFile(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { [PLUGIN_KEY]: [{ scope: 'project', projectPath: repo, installPath: null, version: '0.7.0' }] },
      }),
    )
  }

  const writeCache = (cache: Partial<UpdateCache>): void => {
    writeFile(
      path.join(home, '.cache', 'infra-kit', 'update-check.json'),
      JSON.stringify({ lastCheckMs: 1, latestVersion: null, updateCommand: null, ...cache }),
    )
  }

  const updateSpawned = (): boolean => {
    return calls.some((call) => {
      return call.args.join(' ') === PLUGIN_UPDATE_ARGV.join(' ')
    })
  }

  const withheldLine = (): string | undefined => {
    return warnLines().find((line) => {
      return line.startsWith('Claude Code plugin not updated')
    })
  }

  beforeEach(async () => {
    calls = []

    const actual = await vi.importActual<typeof import('src/lib/plugin-pointer')>('src/lib/plugin-pointer')

    installMock.mockImplementation((options) => {
      return actual.installPluginForProject({ ...options, home, run: recordingRunner })
    })
    writeInstalledRecord()
  })

  it('withholds the update and prints the cached command when the cache says a newer CLI exists', async () => {
    writeCache({ latestVersion: NEWER, updateCommand: ['brew', 'upgrade', 'infra-kit'] })

    await runInit()

    expect(updateSpawned()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(withheldLine()).toBe(
      `Claude Code plugin not updated — CLI ${CURRENT} is behind ${NEWER}, update it first: brew upgrade infra-kit. The plugin follows on the next update check after that.`,
    )
    expect(
      infoLines().some((line) => {
        return line.includes('up to date')
      }),
    ).toBe(false)
  })

  it('falls back to the pinned npm command when the cache has a newer version but no verdict', async () => {
    // `parent-still-running` and `parent-unknown` record the version and a null command.
    writeCache({ latestVersion: NEWER, updateCommand: null })

    await runInit()

    expect(updateSpawned()).toBe(false)
    expect(withheldLine()).toContain(`update it first: npm install -g infra-kit@${NEWER}.`)
  })

  it('updates as before when the cache holds a version that is not newer, without fetching', async () => {
    writeCache({ latestVersion: CURRENT, updateCommand: null })

    await runInit()

    expect(updateSpawned()).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(withheldLine()).toBeUndefined()
    expect(infoLines()).toContain(`Claude Code plugin ${PLUGIN_KEY} up to date (project scope)`)
  })

  it("updates when the cache holds no version at all (the worker's fetch-failed / installed writes)", async () => {
    writeCache({ latestVersion: null, updateCommand: null })

    await runInit()

    expect(updateSpawned()).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches exactly once when no cache exists (opt-out machine) and withholds on a newer version', async () => {
    fetchMock.mockResolvedValue(NEWER)

    await runInit()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(updateSpawned()).toBe(false)
    expect(withheldLine()).toContain(
      `CLI ${CURRENT} is behind ${NEWER}, update it first: npm install -g infra-kit@${NEWER}.`,
    )
  })

  it('updates when no cache exists and the fetch reports nothing newer', async () => {
    fetchMock.mockResolvedValue(CURRENT)

    await runInit()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(updateSpawned()).toBe(true)
    expect(withheldLine()).toBeUndefined()
  })

  it("updates when no cache exists and the fetch fails — unknowable, like the worker's fetch-failed", async () => {
    fetchMock.mockResolvedValue(null)

    await runInit()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(updateSpawned()).toBe(true)
    expect(withheldLine()).toBeUndefined()
  })

  it('never fetches on the fresh-install path: there is no update to withhold', async () => {
    fs.rmSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'))

    await runInit()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(updateSpawned()).toBe(false)
    expect(withheldLine()).toBeUndefined()
  })
})

/**
 * The `mcp-proxies` step: derived `ik-mcp` entries land beside the `infra-kit` key, in a step of
 * their own, so a broken `mcp` block can cost this step and never the plugin install.
 */
describe('setup — the mcp-proxies step', () => {
  const VALID_WITH_MCP = JSON.stringify({
    envManagement: { provider: 'doppler', config: { name: 'x' } },
    mcp: { grafana: { command: 'mcp-grafana', args: ['-t', 'stdio'], env: ['GRAFANA_URL'] } },
  })

  it('derives one .mcp.json entry per mcp.<name>, and no infra-kit key', async () => {
    writeFile(path.join(repo, 'infra-kit.json'), VALID_WITH_MCP)
    resetInfraKitConfigCache()

    await runInit()

    const servers = readMcp().mcpServers ?? {}

    expect(servers['infra-kit'], 'the plugin serves the server; setup writes no key for it').toBeUndefined()
    expect(servers.grafana).toEqual({
      type: 'stdio',
      command: 'ik-mcp',
      args: ['--name', 'grafana', '--env', 'GRAFANA_URL', '--', 'mcp-grafana', '-t', 'stdio'],
    })
    expect(linesMatching(/ik-mcp "grafana"/)).toHaveLength(1)
  })

  it('is idempotent — a second run writes nothing and prints no ik-mcp line', async () => {
    writeFile(path.join(repo, 'infra-kit.json'), VALID_WITH_MCP)
    resetInfraKitConfigCache()

    await runInit()

    const before = fs.readFileSync(mcpPath(), 'utf-8')

    vi.mocked(logger.info).mockClear()
    await runInit()

    expect(fs.readFileSync(mcpPath(), 'utf-8')).toBe(before)
    expect(linesMatching(/ik-mcp/)).toHaveLength(0)
  })

  it('a broken mcp block warns about THIS step only — the plugin pointer still lands', async () => {
    writeFile(
      path.join(repo, 'infra-kit.json'),
      JSON.stringify({
        envManagement: { provider: 'doppler', config: { name: 'x' } },
        mcp: { grafana: { command: 'x', env: ['PATH'] } },
      }),
    )
    resetInfraKitConfigCache()

    await runInit()

    expect(
      warnLines().some((line) => {
        return /ik-mcp entries not synced/.test(line)
      }),
    ).toBe(true)
    expect(readSettings(), 'the plugin pointer must not be a casualty of a bad mcp block').toBeTruthy()
    expect(fs.existsSync(mcpPath()), 'nothing writes .mcp.json when the proxies step refuses').toBe(false)
  })

  it('stays silent when there is no infra-kit.json at all — the guidance gate already said so', async () => {
    fs.rmSync(path.join(repo, 'infra-kit.json'))
    resetInfraKitConfigCache()

    await runInit()

    expect(
      warnLines().filter((line) => {
        return /ik-mcp/.test(line)
      }),
    ).toHaveLength(0)
  })
})

describe('setup — the mcp-proxies step on an unwritable .mcp.json', () => {
  it('warns that the file could not be written instead of claiming it was updated', async () => {
    writeFile(
      path.join(repo, 'infra-kit.json'),
      JSON.stringify({
        envManagement: { provider: 'doppler', config: { name: 'x' } },
        mcp: { grafana: { command: 'mcp-grafana', env: ['GRAFANA_URL'] } },
      }),
    )
    resetInfraKitConfigCache()
    // A directory where the file should be: readable-as-absent is not the case here — it EXISTS and
    // cannot be read or written, which is the reconciler's `unreadable` path, then `failed` on write.
    writeFile(mcpPath(), '{"mcpServers":{}}\n')
    fs.chmodSync(mcpPath(), 0o400)

    try {
      await runInit()

      expect(linesMatching(/ik-mcp "grafana"/), 'no "updated" line may describe a write that failed').toHaveLength(0)
      expect(
        warnLines().some((line) => {
          return /could not be written|Could not write/.test(line)
        }),
      ).toBe(true)
    } finally {
      fs.chmodSync(mcpPath(), 0o600)
    }
  })
})
