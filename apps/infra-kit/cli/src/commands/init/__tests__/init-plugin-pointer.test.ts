import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetGitStateCache } from 'src/lib/agent-guidance'
import { getProjectRoot, getRepoName } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { PLUGIN_INSTALL_COMMAND, PLUGIN_KEY } from 'src/lib/plugin-pointer'

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

  it('writes no .claude directory outside an infra-kit repo', async () => {
    fs.rmSync(path.join(repo, 'infra-kit.json'))
    resetInfraKitConfigCache()

    await init()

    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false)
  })
})
