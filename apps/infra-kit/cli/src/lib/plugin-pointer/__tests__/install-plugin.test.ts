import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CLAUDE_VERSION_ARGV,
  MARKETPLACE_ADD_ARGV,
  PLUGIN_INSTALL_ARGV,
  installPluginForProject,
} from '../install-plugin'
import type { ClaudeCommand, ClaudeCommandResult, ClaudeRunner } from '../install-plugin'

/**
 * The install step, driven entirely through an injected runner.
 *
 * NOTHING here spawns `claude`. The suite's whole subject is which commands are issued, in what
 * order, with what argv and cwd — and a test that actually ran them would install a plugin onto the
 * machine running CI, which is both a side effect and a result that depends on the network.
 *
 * `$HOME` is a temp dir per case for the same reason the sibling host-state suite uses one: the
 * `already-installed` and `unverified` verdicts are read out of `installed_plugins.json`, so a suite
 * that read the developer's real one would pass or fail on whether they happen to use this plugin.
 */

let home: string
let repo: string

/** Every command the runner was handed, in order — the assertion target for most cases. */
interface RecordedRunner {
  runner: ClaudeRunner
  calls: ClaudeCommand[]
}

/**
 * A runner that succeeds by default, with per-argv overrides keyed by the joined argv.
 *
 * Keyed by argv rather than call index so a case says "the marketplace add fails" instead of "the
 * second call fails" — the latter silently changes meaning the day a step is added or skipped.
 */
const recordingRunner = (failures: Record<string, ClaudeCommandResult> = {}): RecordedRunner => {
  const calls: ClaudeCommand[] = []

  return {
    calls,
    runner: (command): ClaudeCommandResult => {
      calls.push(command)

      return failures[command.args.join(' ')] ?? { ok: true }
    },
  }
}

const writeJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

const pluginsDir = (): string => {
  return path.join(home, '.claude', 'plugins')
}

/** Record the plugin as installed for `repo`, exactly as Claude Code writes it. */
const writeInstalledRecord = (): void => {
  writeJson(path.join(pluginsDir(), 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'infra-kit@infra-kit': [
        { scope: 'project', projectPath: repo, installPath: null, version: '0.4.0', installedAt: '2026-09-07' },
      ],
    },
  })
}

const registerMarketplace = (): void => {
  writeJson(path.join(pluginsDir(), 'known_marketplaces.json'), {
    'infra-kit': { source: { source: 'github', repo: 'ArthurSaenz/infra-kit' } },
  })
}

const argvOf = (calls: readonly ClaudeCommand[]): string[][] => {
  return calls.map((call) => {
    return [...call.args]
  })
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-plugin-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'install-plugin-repo-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('installPluginForProject — idempotence', () => {
  it('runs nothing at all when the plugin is already installed for this project', () => {
    writeInstalledRecord()

    const { runner, calls } = recordingRunner()

    expect(installPluginForProject({ projectRoot: repo, home, run: runner })).toEqual({ status: 'already-installed' })
    expect(calls).toEqual([])
  })

  it('still installs when the only record covers another project', () => {
    writeJson(path.join(pluginsDir(), 'installed_plugins.json'), {
      version: 2,
      plugins: { 'infra-kit@infra-kit': [{ scope: 'project', projectPath: '/somewhere/else', version: '0.1.0' }] },
    })
    registerMarketplace()

    const { runner, calls } = recordingRunner()

    installPluginForProject({ projectRoot: repo, home, run: runner })

    expect(argvOf(calls)).toContainEqual([...PLUGIN_INSTALL_ARGV])
  })
})

describe('installPluginForProject — claude on PATH', () => {
  it('reports claude-missing and never reaches the install when the probe fails', () => {
    const { runner, calls } = recordingRunner({
      [CLAUDE_VERSION_ARGV.join(' ')]: { ok: false, output: 'spawn claude ENOENT' },
    })

    expect(installPluginForProject({ projectRoot: repo, home, run: runner })).toEqual({ status: 'claude-missing' })
    expect(argvOf(calls)).toEqual([[...CLAUDE_VERSION_ARGV]])
  })
})

describe('installPluginForProject — command sequence', () => {
  it('registers the marketplace then installs, with the exact argv and cwd, when neither exists', () => {
    const { runner, calls } = recordingRunner()

    installPluginForProject({ projectRoot: repo, home, run: runner })

    expect(argvOf(calls)).toEqual([
      ['--version'],
      ['plugin', 'marketplace', 'add', 'ArthurSaenz/infra-kit'],
      ['plugin', 'install', 'infra-kit@infra-kit', '--scope', 'project'],
    ])
    expect(calls[2]?.cwd).toBe(repo)
  })

  it('skips the marketplace add when the marketplace is already registered', () => {
    registerMarketplace()

    const { runner, calls } = recordingRunner()

    installPluginForProject({ projectRoot: repo, home, run: runner })

    expect(argvOf(calls)).toEqual([[...CLAUDE_VERSION_ARGV], [...PLUGIN_INSTALL_ARGV]])
  })

  /** `--scope user` would activate this plugin's skills in every repo the person opens. */
  it('never passes --scope user', () => {
    const { runner, calls } = recordingRunner()

    installPluginForProject({ projectRoot: repo, home, run: runner })

    expect(
      calls.some((call) => {
        return call.args.includes('user')
      }),
    ).toBe(false)
  })
})

describe('installPluginForProject — failures', () => {
  it('reports the marketplace step and does not attempt the install', () => {
    const { runner, calls } = recordingRunner({
      [MARKETPLACE_ADD_ARGV.join(' ')]: { ok: false, output: 'fatal: could not read from remote\nsecond line' },
    })

    expect(installPluginForProject({ projectRoot: repo, home, run: runner })).toEqual({
      status: 'failed',
      step: 'marketplace',
      error: 'fatal: could not read from remote',
    })
    expect(argvOf(calls)).not.toContainEqual([...PLUGIN_INSTALL_ARGV])
  })

  it('reports the install step with the command first line', () => {
    registerMarketplace()

    const { runner } = recordingRunner({
      [PLUGIN_INSTALL_ARGV.join(' ')]: { ok: false, output: '\nplugin infra-kit@infra-kit not found' },
    })

    expect(installPluginForProject({ projectRoot: repo, home, run: runner })).toEqual({
      status: 'failed',
      step: 'install',
      error: 'plugin infra-kit@infra-kit not found',
    })
  })

  /** Exit 0 is not proof: the plugin is active only once Claude Code records the installation. */
  it('reports unverified when the command succeeds but no record appears', () => {
    registerMarketplace()

    const { runner } = recordingRunner()

    expect(installPluginForProject({ projectRoot: repo, home, run: runner })).toEqual({ status: 'unverified' })
  })
})

describe('installPluginForProject — success', () => {
  it('reports installed once the record the command wrote is visible', () => {
    registerMarketplace()

    const runner: ClaudeRunner = (command): ClaudeCommandResult => {
      if (command.args.join(' ') === PLUGIN_INSTALL_ARGV.join(' ')) writeInstalledRecord()

      return { ok: true }
    }

    expect(installPluginForProject({ projectRoot: repo, home, run: runner })).toEqual({ status: 'installed' })
  })

  it('is idempotent: the second call runs nothing', () => {
    registerMarketplace()

    const calls: ClaudeCommand[] = []
    const runner: ClaudeRunner = (command): ClaudeCommandResult => {
      calls.push(command)
      if (command.args.join(' ') === PLUGIN_INSTALL_ARGV.join(' ')) writeInstalledRecord()

      return { ok: true }
    }

    installPluginForProject({ projectRoot: repo, home, run: runner })

    const afterFirst = calls.length

    expect(installPluginForProject({ projectRoot: repo, home, run: runner })).toEqual({ status: 'already-installed' })
    expect(calls).toHaveLength(afterFirst)
  })
})

describe('installPluginForProject — kill switch', () => {
  /**
   * `vitest.setup.ts` arms `INFRA_KIT_NO_PLUGIN_INSTALL` for every test file, which is what stops the
   * three suites that call the real `init()` from installing this plugin onto the machine running
   * them. Asserted here so removing that line fails a test instead of silently spawning `claude`.
   */
  it('spawns nothing and reports skipped when the switch is armed and no runner is injected', () => {
    expect(process.env.INFRA_KIT_NO_PLUGIN_INSTALL).toBeTruthy()
    expect(installPluginForProject({ projectRoot: repo, home })).toEqual({ status: 'skipped' })
  })

  it('ignores the switch for an injected runner, which cannot spawn anything', () => {
    registerMarketplace()

    const { runner, calls } = recordingRunner()

    installPluginForProject({ projectRoot: repo, home, run: runner })

    expect(argvOf(calls)).toEqual([[...CLAUDE_VERSION_ARGV], [...PLUGIN_INSTALL_ARGV]])
  })
})
