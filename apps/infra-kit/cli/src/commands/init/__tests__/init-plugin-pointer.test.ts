import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetGitStateCache } from 'src/lib/agent-guidance'
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import {
  MARKETPLACE_ADD_COMMAND,
  PLUGIN_INSTALL_COMMAND,
  PLUGIN_KEY,
  installPluginForProject,
} from 'src/lib/plugin-pointer'

import { init } from '../init'

/**
 * `init`'s plugin-pointer step, exercised through the real `init()` rather than the lib.
 *
 * The lib's own suite proves the merge; what can only be proved here is the WIRING — that the step
 * runs, that it targets the repo root the guidance step resolved (not the cwd), and that the install
 * command is printed exactly once and only when the plugin is actually missing.
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
 * The ONE seam this suite fakes, and it must be faked: the real installer spawns `claude`, so on a
 * developer's machine an unmocked run would install a plugin as a side effect of running the tests.
 * Everything else in `src/lib/plugin-pointer` stays real — the pointer merge is what several cases
 * below assert, and a wholesale module mock would make them prove nothing.
 *
 * Its default behaviour is the honest one for a machine with no `claude` binary: `already-installed`
 * when the host state says so (read through the module's OWN resolver, so the fake cannot disagree
 * with the fixtures), `claude-missing` otherwise.
 */
vi.mock('src/lib/plugin-pointer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/plugin-pointer')>()

  return {
    ...actual,
    installPluginForProject: vi.fn((options: { projectRoot: string }) => {
      const installed = actual.resolvePluginInstall({ projectPath: options.projectRoot }).kind === 'installed'

      return installed ? { status: 'already-installed' } : { status: 'claude-missing' }
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

beforeEach(() => {
  vi.clearAllMocks()

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'init-pointer-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'init-pointer-repo-'))

  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getRepoName).mockResolvedValue(path.basename(repo))

  writeFile(path.join(repo, 'infra-kit.json'), '{}\n')
  process.env.INFRA_KIT_NO_SEED = '1'

  resetInfraKitConfigCache()
  resetGitStateCache()
})

afterEach(() => {
  delete process.env.INFRA_KIT_NO_SEED
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('init — plugin pointer', () => {
  it('creates .claude/settings.json at the repo root with both keys', async () => {
    await init()

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

    await init()

    const settings = readSettings()

    expect(settings.permissions?.deny).toEqual(['Bash(rm:*)'])
    expect(Object.keys(settings.enabledPlugins ?? {})).toEqual(['omc@omc', PLUGIN_KEY])
  })

  it('prints the install command verbatim when the plugin is not installed', async () => {
    await init()

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

    await init()

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

    await init()

    expect(infoLines()).toContain(PLUGIN_INSTALL_COMMAND)
  })

  it('is idempotent: a second init leaves the file byte-identical', async () => {
    await init()

    const first = fs.readFileSync(settingsPath(), 'utf-8')

    await init()

    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(first)
  })

  it('prints the marketplace command alongside the install command when claude is missing', async () => {
    await init()

    expect(infoLines()).toContain(MARKETPLACE_ADD_COMMAND)
    expect(infoLines().indexOf(MARKETPLACE_ADD_COMMAND)).toBeLessThan(infoLines().indexOf(PLUGIN_INSTALL_COMMAND))
  })

  it('writes no .claude directory outside an infra-kit repo', async () => {
    fs.rmSync(path.join(repo, 'infra-kit.json'))
    resetInfraKitConfigCache()

    await init()

    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false)
  })
})

/**
 * The install step's WIRING. What the installer itself does is proved against an injected runner in
 * `lib/plugin-pointer/__tests__/install-plugin.test.ts`; what only `init` can prove is that the step
 * runs at all, that it is aimed at the resolved repo root rather than the cwd, and that each outcome
 * reaches the user as one readable line.
 */
describe('init — plugin install', () => {
  const installMock = vi.mocked(installPluginForProject)

  const warnLines = (): string[] => {
    return vi.mocked(logger.warn).mock.calls.map((call) => {
      return typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0])
    })
  }

  it('installs the plugin for the resolved repo root', async () => {
    await init()

    expect(installMock).toHaveBeenCalledTimes(1)
    expect(installMock).toHaveBeenCalledWith({ projectRoot: repo })
  })

  it('reports a successful install on one INFO line', async () => {
    installMock.mockReturnValue({ status: 'installed' })

    await init()

    expect(infoLines()).toContain(`installed Claude Code plugin ${PLUGIN_KEY} (project scope)`)
  })

  it('says nothing on INFO when the plugin was already installed', async () => {
    installMock.mockReturnValue({ status: 'already-installed' })

    await init()

    // The pointer step's own `(Claude Code plugin pointer)` line is legitimate and stays; what must
    // NOT appear is any report about the install, which on a configured machine did nothing.
    expect(
      infoLines().some((line) => {
        return line.includes('installed Claude Code plugin') || line.includes('claude plugin')
      }),
    ).toBe(false)
  })

  it('warns with the step and the error first line when a step fails', async () => {
    installMock.mockReturnValue({ status: 'failed', step: 'marketplace', error: 'could not read from remote' })

    await init()

    const warning = warnLines().find((line) => {
      return line.includes('Could not install the Claude Code plugin')
    })

    expect(warning).toContain('marketplace')
    expect(warning).toContain('could not read from remote')
    expect(warning).toContain(PLUGIN_INSTALL_COMMAND)
  })

  it('warns rather than claiming success when Claude Code recorded no installation', async () => {
    installMock.mockReturnValue({ status: 'unverified' })

    await init()

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

    await expect(init()).resolves.toBeUndefined()
    expect(readSettings().enabledPlugins?.[PLUGIN_KEY]).toBe(true)
  })
})
