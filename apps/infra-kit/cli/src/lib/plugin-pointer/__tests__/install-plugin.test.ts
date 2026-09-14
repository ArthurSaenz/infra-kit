import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CLAUDE_VERSION_ARGV, PLUGIN_UPDATE_ARGV, defaultClaudeRunner } from '../claude-cli'
import type { ClaudeCommand, ClaudeCommandResult, ClaudeRunner } from '../claude-cli'
import { MARKETPLACE_ADD_ARGV, PLUGIN_INSTALL_ARGV, installPluginForProject } from '../install-plugin'

/**
 * The install step, driven entirely through an injected runner.
 *
 * NOTHING here spawns `claude`. The suite's whole subject is which commands are issued, in what
 * order, with what argv and cwd — and a test that actually ran them would install a plugin onto the
 * machine running CI, which is both a side effect and a result that depends on the network.
 *
 * `$HOME` is a temp dir per case for the same reason the sibling host-state suite uses one: the
 * installed-here (→ update) and `unverified` verdicts are read out of `installed_plugins.json`, so a
 * suite that read the developer's real one would pass or fail on whether they happen to use this plugin.
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

describe('installPluginForProject — already installed → update', () => {
  it('runs only `plugin update`, with the exact argv and the project as cwd, and reports updated', () => {
    // The cwd IS the scope resolution: `claude` picks which project-scope record an update advances
    // from the directory it runs in, and from any other directory it silently picks some other record.
    writeInstalledRecord()

    const { runner, calls } = recordingRunner()

    expect(installPluginForProject({ projectRoot: repo, home, run: runner })).toEqual({ status: 'updated' })
    expect(argvOf(calls)).toEqual([[...CLAUDE_VERSION_ARGV], [...PLUGIN_UPDATE_ARGV]])
    expect(calls[1]?.cwd).toBe(repo)
    expect(argvOf(calls)).not.toContainEqual([...PLUGIN_INSTALL_ARGV])
    expect(argvOf(calls)).not.toContainEqual([...MARKETPLACE_ADD_ARGV])
  })

  it('passes --scope project and -y, the two flags the update fails without off a TTY', () => {
    expect([...PLUGIN_UPDATE_ARGV]).toEqual(['plugin', 'update', 'infra-kit@infra-kit', '--scope', 'project', '-y'])
  })

  it('reports update-failed with the command first line when the update exits non-zero', () => {
    writeInstalledRecord()

    const { runner } = recordingRunner({
      [PLUGIN_UPDATE_ARGV.join(' ')]: { ok: false, output: '\nPlugin infra-kit is not installed at scope user\nmore' },
    })

    expect(installPluginForProject({ projectRoot: repo, home, run: runner })).toEqual({
      status: 'update-failed',
      error: 'Plugin infra-kit is not installed at scope user',
    })
  })

  it('reports claude-missing without attempting the update when the probe fails', () => {
    writeInstalledRecord()

    const { runner, calls } = recordingRunner({
      [CLAUDE_VERSION_ARGV.join(' ')]: { ok: false, output: 'spawn claude ENOENT' },
    })

    expect(installPluginForProject({ projectRoot: repo, home, run: runner })).toEqual({ status: 'claude-missing' })
    expect(argvOf(calls)).toEqual([[...CLAUDE_VERSION_ARGV]])
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

  it('is idempotent: the second call installs nothing and only updates', () => {
    registerMarketplace()

    const calls: ClaudeCommand[] = []
    const runner: ClaudeRunner = (command): ClaudeCommandResult => {
      calls.push(command)
      if (command.args.join(' ') === PLUGIN_INSTALL_ARGV.join(' ')) writeInstalledRecord()

      return { ok: true }
    }

    installPluginForProject({ projectRoot: repo, home, run: runner })

    const afterFirst = calls.length

    expect(installPluginForProject({ projectRoot: repo, home, run: runner })).toEqual({ status: 'updated' })
    expect(argvOf(calls.slice(afterFirst))).toEqual([[...CLAUDE_VERSION_ARGV], [...PLUGIN_UPDATE_ARGV]])
  })
})

describe('the PATH shim that protects every suite', () => {
  /**
   * `vitest.setup.ts` prepends `src/__fixtures__/bin` to `PATH` so the three suites that call the real
   * `initCore` reach a fake `claude` instead of the developer's own. There is no product-facing kill
   * switch, so this shim is the ONLY thing standing between a test run and a real plugin install —
   * asserted here, through the real runner, so removing that setup line fails a test.
   */
  it('is what defaultClaudeRunner reaches for `claude --version`', () => {
    const result = defaultClaudeRunner({ args: [...CLAUDE_VERSION_ARGV] })

    expect(result.ok).toBe(true)
    expect(result.output).toContain('0.0.0-fake')
  })

  it('exits 0 for all three plugin subcommands while writing no installed_plugins.json', () => {
    expect(defaultClaudeRunner({ args: [...MARKETPLACE_ADD_ARGV] }).ok).toBe(true)
    expect(defaultClaudeRunner({ args: [...PLUGIN_INSTALL_ARGV], cwd: repo }).ok).toBe(true)
    expect(defaultClaudeRunner({ args: [...PLUGIN_UPDATE_ARGV], cwd: repo }).ok).toBe(true)
    expect(fs.existsSync(path.join(pluginsDir(), 'installed_plugins.json'))).toBe(false)
  })

  /**
   * Consequently a full uninjected run reports `unverified`, never `installed` — the honest verdict
   * for a command that exited 0 and left no record behind.
   */
  it('drives an uninjected install to unverified, so init warns instead of claiming success', () => {
    registerMarketplace()

    expect(installPluginForProject({ projectRoot: repo, home })).toEqual({ status: 'unverified' })
  })
})
