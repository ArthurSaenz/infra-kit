import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolvePluginInstall } from 'src/lib/plugin-pointer'

import {
  checkAgentAllowlist,
  checkAgentMode,
  checkClaudeCli,
  checkClaudePlugin,
  checkMcpServerKey,
  inspectServedPluginServer,
} from '../doctor'
import { DOCTOR_CHECK_NAMES, groupChecks } from '../report'

/**
 * O3 and T4(b) — the doctor rows about the Claude Code plugin.
 *
 * `$HOME` is stubbed to a temp dir for every case, so the verdicts come from a fixture rather than
 * from whether the author happens to have the plugin installed. `os.homedir()` reads `HOME` on
 * POSIX, which is what makes the stub reach the readers without threading a seam through the checks.
 */

/**
 * `checkClaudeCli` is the one row here that SPAWNS. Mocked so the verdict is the fixture's, not the
 * machine's, and driven through {@link spawnOutcome} rather than by re-stubbing `$` per case — `$` is a
 * tag AND a factory, and a `mockResolvedValue` on it replaces the factory too, which leaves the
 * production code holding a promise where it expects a configured tag.
 */
const spawnOutcome = { reject: false }

vi.mock('zx', async () => {
  // Imported INSIDE the factory: `vi.mock` is hoisted above the imports, and `doctor.ts` pulls
  // in `zx` at module scope, so a top-level binding is still in its TDZ when this runs.
  const { zxShellMock } = await import('src/lib/quiet-shell/__tests__/zx-shell-mock')

  return zxShellMock(() => {
    if (spawnOutcome.reject) return Promise.reject(new Error('command not found: claude'))

    return Promise.resolve({ stdout: '2.0.0 (Claude Code)' })
  })
})

let home: string
let repo: string

const statusOf = (checks: ReturnType<typeof checkClaudePlugin>, name: string): string | undefined => {
  return checks.find((check) => {
    return check.name === name
  })?.status
}

const messageOf = (checks: ReturnType<typeof checkClaudePlugin>, name: string): string => {
  return (
    checks.find((check) => {
      return check.name === name
    })?.message ?? ''
  )
}

const writeJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

/** The `.mcp.json` the plugin shipped BEFORE it went skills-only — what a stale served copy still carries. */
const SERVED_MCP = { mcpServers: { 'infra-kit': { type: 'stdio', command: 'infra-kit', args: ['mcp'] } } }

/** As shipped now: skills only, no `.mcp.json`. */
const installPlugin = (version = '0.4.0', served: unknown = null, name = 'infra-kit'): string => {
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'infra-kit')

  writeJson(path.join(installPath, '.claude-plugin', 'plugin.json'), { name, version })
  if (served !== null) writeJson(path.join(installPath, '.mcp.json'), served)
  writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'infra-kit@infra-kit': [
        { scope: 'project', projectPath: repo, installPath, version: 'deadbeef', installedAt: '2026-09-06' },
      ],
    },
  })

  return installPath
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-plugin-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-plugin-repo-'))
  vi.stubEnv('HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('checkClaudePlugin', () => {
  it('emits the five rows in order, whatever the host state', () => {
    expect(
      checkClaudePlugin(repo).map((check) => {
        return check.name
      }),
    ).toEqual(['marketplace registered', 'plugin installed', 'plugin version', 'plugin MCP server', 'CLI version'])
  })

  it('fails marketplace, install and version on a machine that has none of it', () => {
    const checks = checkClaudePlugin(repo)

    expect(statusOf(checks, 'marketplace registered')).toBe('fail')
    expect(statusOf(checks, 'plugin installed')).toBe('fail')
    expect(statusOf(checks, 'plugin version')).toBe('fail')
    expect(messageOf(checks, 'marketplace registered')).toContain('claude plugin marketplace add ArthurSaenz/infra-kit')
    expect(messageOf(checks, 'plugin installed')).toContain('claude plugin install infra-kit@infra-kit --scope project')
  })

  it('passes all five once the marketplace is registered and the skills-only plugin installed', () => {
    writeJson(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), {
      'infra-kit': { source: { source: 'github', repo: 'ArthurSaenz/infra-kit' } },
    })
    installPlugin()

    const checks = checkClaudePlugin(repo)

    expect(
      checks.every((check) => {
        return check.status === 'pass'
      }),
    ).toBe(true)
    expect(messageOf(checks, 'plugin version')).toContain('0.4.0')
    expect(messageOf(checks, 'plugin installed')).toContain('project scope')
  })

  it('always reports the CLI version as a passing row', () => {
    const cli = checkClaudePlugin(null).find((check) => {
      return check.name === 'CLI version'
    })

    expect(cli?.status).toBe('pass')
    expect(cli?.message).toMatch(/^infra-kit CLI \d+\.\d+\.\d+/)
  })

  /** The live defect: a plugin installed for an unrelated scratch dir reported a green row here. */
  it('fails, naming the other project, when the plugin is installed only elsewhere', () => {
    writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'infra-kit@infra-kit': [
          {
            scope: 'project',
            projectPath: '/Users/someone/projects/scratch-repo-1',
            installPath: null,
            version: '0.1.0',
          },
        ],
      },
    })

    const checks = checkClaudePlugin(repo)

    expect(statusOf(checks, 'plugin installed')).toBe('fail')
    expect(messageOf(checks, 'plugin installed')).toContain('/Users/someone/projects/scratch-repo-1')
    expect(messageOf(checks, 'plugin installed')).toContain('only, not this project')
    expect(statusOf(checks, 'plugin version')).toBe('fail')
  })

  it('names at most three other projects and counts the rest', () => {
    writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'infra-kit@infra-kit': ['a', 'b', 'c', 'd', 'e'].map((name) => {
          return { scope: 'project', projectPath: `/Users/someone/${name}`, installPath: null, version: '0.1.0' }
        }),
      },
    })

    const message = messageOf(checkClaudePlugin(repo), 'plugin installed')

    expect(message).toContain('/Users/someone/a, /Users/someone/b, /Users/someone/c and 2 more')
    expect(message).not.toContain('/Users/someone/d')
  })

  it('counts a user-scope install as installed even with no project root', () => {
    writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'infra-kit@infra-kit': [{ scope: 'user', projectPath: null, installPath: null, version: '0.1.0' }] },
    })

    expect(statusOf(checkClaudePlugin(null), 'plugin installed')).toBe('pass')
  })

  it('does NOT count a project-scope install for another repo when there is no project root', () => {
    installPlugin()

    expect(statusOf(checkClaudePlugin(null), 'plugin installed')).toBe('fail')
  })
})

/**
 * Step 0c of the MCP-via-plugin plan (§8.0). Sessions load the plugin from the record's cache
 * `installPath`, not from the marketplace clone (§6.1 S0-7(b)), and a failing `claude plugin update`
 * still refreshes the clone — so the clone can be AHEAD of what a session serves, and that is the
 * only freshness comparison the row is allowed to make. Never a status change: the row is `pass`
 * whenever a served version can be read, advisory or not.
 */
describe('plugin version — fetched-but-not-applied advisory', () => {
  const ADVISORY = 'fetched but not applied'
  const UPDATE_COMMAND = 'claude plugin update infra-kit@infra-kit --scope project'

  const writeClone = (manifest: unknown): void => {
    writeJson(
      path.join(
        home,
        '.claude',
        'plugins',
        'marketplaces',
        'infra-kit',
        'plugins',
        'infra-kit',
        '.claude-plugin',
        'plugin.json',
      ),
      manifest,
    )
  }

  it('advises, naming the fetched version and the update command, when the clone is ahead of the served copy', () => {
    installPlugin('0.7.0')
    writeClone({ name: 'infra-kit', version: '0.8.0' })

    const checks = checkClaudePlugin(repo)
    const message = messageOf(checks, 'plugin version')

    expect(statusOf(checks, 'plugin version')).toBe('pass')
    expect(message).toContain('version 0.7.0')
    expect(message).toContain(`plugin 0.8.0 is ${ADVISORY}`)
    expect(message).toContain(`Run: ${UPDATE_COMMAND}`)
  })

  it('stays silent when the clone and the served copy agree', () => {
    installPlugin('0.7.0')
    writeClone({ name: 'infra-kit', version: '0.7.0' })

    const checks = checkClaudePlugin(repo)

    expect(statusOf(checks, 'plugin version')).toBe('pass')
    expect(messageOf(checks, 'plugin version')).toBe('Plugin infra-kit@infra-kit version 0.7.0')
  })

  /** A stale clone behind a newer served copy is not a lag to fix — no advisory. */
  it('stays silent when the served copy is AHEAD of the clone', () => {
    installPlugin('0.8.0')
    writeClone({ name: 'infra-kit', version: '0.7.0' })

    const checks = checkClaudePlugin(repo)

    expect(statusOf(checks, 'plugin version')).toBe('pass')
    expect(messageOf(checks, 'plugin version')).toBe('Plugin infra-kit@infra-kit version 0.8.0')
  })

  it('stays silent when there is no clone to compare against', () => {
    installPlugin('0.7.0')

    const checks = checkClaudePlugin(repo)

    expect(statusOf(checks, 'plugin version')).toBe('pass')
    expect(messageOf(checks, 'plugin version')).toBe('Plugin infra-kit@infra-kit version 0.7.0')
  })

  it('stays silent, never throws, on a clone manifest that cannot be read', () => {
    installPlugin('0.7.0')
    writeClone({ name: 'infra-kit' })

    expect(messageOf(checkClaudePlugin(repo), 'plugin version')).toBe('Plugin infra-kit@infra-kit version 0.7.0')

    fs.writeFileSync(
      path.join(
        home,
        '.claude',
        'plugins',
        'marketplaces',
        'infra-kit',
        'plugins',
        'infra-kit',
        '.claude-plugin',
        'plugin.json',
      ),
      '{not json',
      'utf-8',
    )

    expect(messageOf(checkClaudePlugin(repo), 'plugin version')).toBe('Plugin infra-kit@infra-kit version 0.7.0')
  })

  /**
   * P6, pinned at the source: the plugin bump is a separate commit after every lockstep release, so
   * served-vs-CLI drifts legitimately for hours at every release. The row must never compare against
   * the CLI's own version — `packageJson.version` is the one symbol `doctor.ts` reads it through
   * (the `CLI version` row and the MCP tool's `cliVersion`), so its absence from the version row and
   * its advisory helper is the whole guarantee.
   */
  it('never compares the served plugin against the CLI version (source guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'doctor.ts'), 'utf-8')
    const rowSource = /const fetchedNotAppliedAdvisory[\s\S]*?\nconst claudePluginVersionCheck[\s\S]*?\n\}\n/.exec(
      source,
    )?.[0]

    expect(rowSource).toBeDefined()
    expect(source).toContain('packageJson.version')
    expect(rowSource).not.toMatch(/packageJson|cliVersion|CLI_VERSION|currentVersion/)
  })
})

/**
 * Plan §3.3 Rows, `plugin MCP server`: capability-keyed on the SERVED copy (the install record's
 * `installPath`), never on a version floor and never on the marketplace clone.
 */
describe('plugin MCP server — flipped: a served .mcp.json is the stale state', () => {
  const UPDATE_COMMAND = 'claude plugin update infra-kit@infra-kit --scope project'

  it('fails, with the install command, when no plugin is installed for this project', () => {
    const checks = checkClaudePlugin(repo)

    expect(statusOf(checks, 'plugin MCP server')).toBe('fail')
    expect(messageOf(checks, 'plugin MCP server')).toContain(
      'claude plugin install infra-kit@infra-kit --scope project',
    )
  })

  it('passes as skills-only when the served copy has no .mcp.json — the shipped shape', () => {
    installPlugin('0.8.0')

    const checks = checkClaudePlugin(repo)

    expect(statusOf(checks, 'plugin MCP server')).toBe('pass')
    expect(messageOf(checks, 'plugin MCP server')).toBe(
      'Plugin infra-kit@infra-kit 0.8.0 is skills-only — no .mcp.json, as shipped; the /infra-kit:* skills drive the infra-kit CLI',
    )
  })

  it('passes with the update advisory when the served copy still carries the old .mcp.json', () => {
    installPlugin('0.7.7', SERVED_MCP)

    const checks = checkClaudePlugin(repo)

    expect(statusOf(checks, 'plugin MCP server')).toBe('pass')
    expect(messageOf(checks, 'plugin MCP server')).toContain('0.7.7 still carries an MCP server in its .mcp.json')
    expect(messageOf(checks, 'plugin MCP server')).toContain('under "infra-kit"')
    expect(messageOf(checks, 'plugin MCP server')).toContain('infra-kit setup')
    expect(messageOf(checks, 'plugin MCP server')).toContain(UPDATE_COMMAND)
    expect(messageOf(checks, 'plugin MCP server')).toContain('restart Claude Code')
  })

  /** Whatever the file keys the server under, its presence is what dates the copy. */
  it('reports a served .mcp.json under another key as stale too, naming the key', () => {
    installPlugin('0.7.7', { mcpServers: { ik: { type: 'stdio', command: 'infra-kit', args: ['mcp'] } } })

    const checks = checkClaudePlugin(repo)

    expect(statusOf(checks, 'plugin MCP server')).toBe('pass')
    expect(messageOf(checks, 'plugin MCP server')).toContain('under "ik"')
    expect(messageOf(checks, 'plugin MCP server')).toContain(UPDATE_COMMAND)
  })

  /** Capability-keyed: an old version hand-stripped of the file is skills-only; there is no version floor. */
  it('passes a served 0.7.0 that carries no .mcp.json', () => {
    installPlugin('0.7.0')

    expect(messageOf(checkClaudePlugin(repo), 'plugin MCP server')).toContain('is skills-only')
  })

  /** Edit 7: the served copy is the RECORD's path; a clone that is ahead changes nothing. */
  it('reads the install record path, not a marketplace clone that differs from it', () => {
    installPlugin('0.7.7', SERVED_MCP)
    writeJson(
      path.join(
        home,
        '.claude',
        'plugins',
        'marketplaces',
        'infra-kit',
        'plugins',
        'infra-kit',
        '.claude-plugin',
        'plugin.json',
      ),
      { name: 'infra-kit', version: '0.8.0' },
    )

    expect(messageOf(checkClaudePlugin(repo), 'plugin MCP server')).toContain('still carries an MCP server')
    expect(inspectServedPluginServer(resolvePluginInstall({ projectPath: repo }))).toEqual({
      kind: 'stale-server',
      version: '0.7.7',
      keys: ['infra-kit'],
    })
  })

  it('never reads the CLI version and spells no version floor (source guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'doctor.ts'), 'utf-8')
    const rowSource = /export type ServedPluginServer[\s\S]*?\nexport const checkClaudePlugin/.exec(source)?.[0]

    expect(rowSource).toBeDefined()
    expect(rowSource).not.toMatch(/packageJson|MIN_PLUGIN_VERSION|isNewerVersion/)
    // No version literal either: a floor spelled as `0.8.0` is the same comparison by another name.
    expect(rowSource).not.toMatch(/\d\.\d\.\d/)
  })
})

/**
 * `MCP server key`: the repo's own `.mcp.json` against the retired server. A leftover key under ANY
 * name is a chore (pass + "delete this key"), no key is the healthy state, and only an unreadable file
 * fails. No transition guard any more: the plugin serves nothing, so the served copy cannot change
 * what the repo's entry means.
 */
describe('checkMcpServerKey', () => {
  const writeMcp = (value: unknown): void => {
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify(value, null, 2), 'utf-8')
  }

  it('passes with the "delete this key" advisory on a leftover infra-kit key (stale)', () => {
    writeMcp({ mcpServers: { 'infra-kit': { type: 'stdio', command: 'infra-kit', args: ['mcp'] } } })

    const check = checkMcpServerKey(repo)

    expect(check.status).toBe('pass')
    expect(check.message).toContain('still registers "infra-kit" — delete this key')
    expect(check.message).toContain('the plugin no longer serves an MCP server')
    expect(check.message).toContain('spawns a retired subcommand that exits immediately')
    expect(check.message).toContain('Delete the "infra-kit" entry from .mcp.json by hand')
  })

  it('passes as nothing-to-spawn when only siblings remain (absent)', () => {
    writeMcp({ mcpServers: { 'linear-server': { type: 'http', url: 'https://mcp.linear.app/mcp' } } })

    const check = checkMcpServerKey(repo)

    expect(check.status).toBe('pass')
    expect(check.message).toContain('no "infra-kit" key')
    expect(check.message).toContain('nothing spawns the retired server')
  })

  it('passes as nothing-to-spawn when there is no .mcp.json at all', () => {
    const check = checkMcpServerKey(repo)

    expect(check.status).toBe('pass')
    expect(check.message).toContain('no .mcp.json at the repo root')
    expect(check.message).not.toContain('infra-kit setup')
  })

  /** The same chore under another key: named, and no longer red — there is no prefix left for it to break. */
  it('passes with the advisory, naming the key, when our server is filed under another key', () => {
    writeMcp({ mcpServers: { ik: { type: 'stdio', command: 'infra-kit', args: ['mcp'] } } })

    const check = checkMcpServerKey(repo)

    expect(check.status).toBe('pass')
    expect(check.message).toContain('still registers "ik" — delete this key')
    expect(check.message).toContain('Delete the "ik" entry from .mcp.json by hand')
  })

  /** The pre-plugin shape spawned the deleted bundle by path; it is the same leftover, under whatever key. */
  it('names the key for a `node …/dist/mcp.js` entry too (wrong-key by the args path)', () => {
    writeMcp({ mcpServers: { ik: { type: 'stdio', command: 'node', args: ['./node_modules/infra-kit/dist/mcp.js'] } } })

    const check = checkMcpServerKey(repo)

    expect(check.status).toBe('pass')
    expect(check.message).toContain('still registers "ik" — delete this key')
    expect(check.message).toContain('spawns a retired subcommand that exits immediately')
  })

  it('fails on a file it cannot read', () => {
    fs.writeFileSync(path.join(repo, '.mcp.json'), '{ nope', 'utf-8')

    const check = checkMcpServerKey(repo)

    expect(check.status).toBe('fail')
    expect(check.message).toContain('Could not read mcpServers')
  })

  /** Edit 8 at the row: a proxy whose args mention infra-kit is not a misfiled server. */
  it('does not read an ik-mcp proxy named like us as wrong-key', () => {
    writeMcp({ mcpServers: { grafana: { command: 'ik-mcp', args: ['--name', 'infra-kit-x', '--', 'mcp-grafana'] } } })

    expect(checkMcpServerKey(repo).message).toContain('nothing spawns the retired server')
  })

  it('spells no tool prefix at all (source guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'doctor.ts'), 'utf-8')

    expect(source).not.toMatch(/mcp__/)
    expect(source).not.toMatch(/tool-prefix/)
  })

  /**
   * Exit 1 is scoped to `plugin installed` alone (F14): none of the MCP or agent rows may reach the
   * exit code, whatever their status. Pinned at the source of the CLI action, which is the only
   * place the code is set.
   */
  it('never drives the exit code — only plugin installed does (source guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'lib', 'program', 'program.ts'), 'utf-8')
    const action = /const pluginMissing = [\s\S]*?process\.exitCode = 1/.exec(source)?.[0]

    expect(action).toBeDefined()
    expect(action).toContain("check.name === 'plugin installed'")
    expect(action).not.toMatch(/MCP server key|plugin MCP server|Agent mode|Agent allowlist/)
  })
})

/**
 * `Agent mode` (plan §3.1): the precedence table, read back as a row. Every case is a PASS — the row
 * reports a classification, it does not judge one — so the assertions are about the message alone.
 */
describe('checkAgentMode', () => {
  it('reports the --agent flag, and that it beats the environment', () => {
    const check = checkAgentMode({ env: { INFRA_KIT_AGENT: '0' }, stdinIsTTY: true, flag: true })

    expect(check.status).toBe('pass')
    expect(check.message).toMatch(/^agent — the --agent flag/)
    expect(check.message).toContain('INFRA_KIT_AGENT = "0"')
    expect(check.message).toContain('--agent passed')
  })

  it('reports INFRA_KIT_AGENT=1 as the source', () => {
    const check = checkAgentMode({ env: { INFRA_KIT_AGENT: '1' }, stdinIsTTY: true, flag: false })

    expect(check.message).toMatch(/^agent — INFRA_KIT_AGENT=1/)
    expect(check.message).toContain('stdin is a TTY')
  })

  it('reports the CLAUDECODE heuristic, with both of its inputs', () => {
    const check = checkAgentMode({ env: { CLAUDECODE: '1' }, stdinIsTTY: false, flag: false })

    expect(check.message).toMatch(/^agent — CLAUDECODE is set and stdin is not a TTY/)
    expect(check.message).toContain('CLAUDECODE set')
    expect(check.message).toContain('INFRA_KIT_AGENT unset')
    expect(check.message).toContain('stdin is not a TTY')
  })

  it('explains a terminal Claude Code spawned for a person as human', () => {
    const check = checkAgentMode({ env: { CLAUDECODE: '1' }, stdinIsTTY: true, flag: false })

    expect(check.message).toMatch(/^human — CLAUDECODE is set but stdin is a TTY/)
  })

  it('explains INFRA_KIT_AGENT=0 as the suppressed heuristic', () => {
    const check = checkAgentMode({ env: { CLAUDECODE: '1', INFRA_KIT_AGENT: '0' }, stdinIsTTY: false, flag: false })

    expect(check.message).toMatch(/^human — INFRA_KIT_AGENT=0 suppresses/)
  })

  it('names how to opt in when nothing fires', () => {
    const check = checkAgentMode({ env: {}, stdinIsTTY: true, flag: false })

    expect(check.status).toBe('pass')
    expect(check.message).toMatch(/^human — no source fires; pass --agent or set INFRA_KIT_AGENT=1/)
    expect(check.message).toContain('CLAUDECODE unset')
  })

  it('never fails, whatever the inputs', () => {
    for (const flag of [true, false])
      for (const stdinIsTTY of [true, false])
        for (const env of [{}, { CLAUDECODE: '1' }, { INFRA_KIT_AGENT: '1' }, { INFRA_KIT_AGENT: 'yes' }])
          expect(checkAgentMode({ env, stdinIsTTY, flag }).status).toBe('pass')
  })
})

/**
 * `Agent allowlist` (plan §3.8): the row over real settings files in a temp repo. The matching rule
 * itself is pinned in `agent-allowlist.test.ts`; here it is the verdict, the file it names, and the
 * three non-warning shapes.
 */
describe('checkAgentAllowlist', () => {
  const writeSettings = (file: string, value: unknown): void => {
    writeJson(path.join(repo, file), value)
  }

  it('passes, naming both files, when neither exists', () => {
    const check = checkAgentAllowlist(repo)

    expect(check.status).toBe('pass')
    expect(check.message).toContain('no .claude/settings.json or .claude/settings.local.json at the repo root')
  })

  it('passes when the allow list reaches only read-only commands', () => {
    writeSettings('.claude/settings.json', {
      permissions: { allow: ['Bash(infra-kit release list:*)', 'Bash(ik worktrees list:*)', 'Bash(git status:*)'] },
    })

    const check = checkAgentAllowlist(repo)

    expect(check.status).toBe('pass')
    expect(check.message).toContain('no permissions.allow pattern in .claude/settings.json reaches')
  })

  it('warns on a prefix allow, naming the file, the pattern and what it reaches', () => {
    writeSettings('.claude/settings.local.json', { permissions: { allow: ['Bash(infra-kit release remove:*)'] } })

    const check = checkAgentAllowlist(repo)

    expect(check.status).toBe('warn')
    expect(check.message).toContain('.claude/settings.local.json allows "Bash(infra-kit release remove:*)"')
    expect(check.message).toContain('reaches 1 mutating infra-kit command (release remove)')
    expect(check.message).toContain('--yes re-run')
    expect(check.message).toContain('Bash(infra-kit release list:*)')
  })

  it('caps the named commands and counts the rest on a whole-CLI allow', () => {
    writeSettings('.claude/settings.json', { permissions: { allow: ['Bash(infra-kit:*)'] } })

    const check = checkAgentAllowlist(repo)

    expect(check.status).toBe('warn')
    expect(check.message).toMatch(
      /reaches \d+ mutating infra-kit commands \(dev, release merge-dev, release create, release edit \+\d+ more\)/,
    )
  })

  it('reports every offending pattern across both files, checked-in file first', () => {
    writeSettings('.claude/settings.json', { permissions: { allow: ['Bash(pnpm exec infra-kit worktrees:*)'] } })
    writeSettings('.claude/settings.local.json', { permissions: { allow: ['Bash(ik env-load:*)'] } })

    const check = checkAgentAllowlist(repo)

    expect(check.status).toBe('warn')
    expect(check.message.indexOf('.claude/settings.json allows')).toBeLessThan(
      check.message.indexOf('.claude/settings.local.json allows'),
    )
    expect(check.message).toContain('(worktrees add, worktrees remove, worktrees sync)')
    expect(check.message).toContain('(env-load)')
  })

  it('warns, naming the file, when a settings file cannot be parsed', () => {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{ nope', 'utf-8')

    const check = checkAgentAllowlist(repo)

    expect(check.status).toBe('warn')
    expect(check.message).toContain('Could not read permissions.allow from .claude/settings.local.json')
  })
})

/**
 * Plan §3.3, `plugin installed` subdirectory advisory. `doctor` cannot see where Claude Code was
 * launched; `CLAUDE_PROJECT_DIR` (MCP-served) is the precise test and the typed CLI's cwd is a hint.
 * Message-only in both — status is about the record.
 */
describe('plugin installed — subdirectory advisory', () => {
  it('advises precisely when CLAUDE_PROJECT_DIR is below the git root (MCP-served doctor)', () => {
    installPlugin()

    const sub = path.join(repo, 'apps')

    fs.mkdirSync(sub)

    const checks = checkClaudePlugin(repo, { projectDir: sub, cwd: sub, gitRoot: repo })

    expect(statusOf(checks, 'plugin installed')).toBe('pass')
    expect(messageOf(checks, 'plugin installed')).toContain('this session was launched from')
    expect(messageOf(checks, 'plugin installed')).toContain('restart Claude Code there')
    expect(messageOf(checks, 'plugin installed')).not.toContain('if Claude Code was launched')
  })

  it('hedges when only the cwd differs from the git root (typed CLI)', () => {
    installPlugin()

    const sub = path.join(repo, 'apps')

    fs.mkdirSync(sub)

    const checks = checkClaudePlugin(repo, { projectDir: null, cwd: sub, gitRoot: repo })

    expect(statusOf(checks, 'plugin installed')).toBe('pass')
    expect(messageOf(checks, 'plugin installed')).toContain('if Claude Code was launched from')
    expect(messageOf(checks, 'plugin installed')).toContain('launch it at')
  })

  it('says nothing when the launch directory is the root, even through a symlinked path', () => {
    installPlugin()

    const link = path.join(os.tmpdir(), `doctor-plugin-link-${path.basename(repo)}`)

    fs.symlinkSync(repo, link)

    try {
      const message = messageOf(
        checkClaudePlugin(repo, { projectDir: link, cwd: link, gitRoot: repo }),
        'plugin installed',
      )

      expect(message).toBe(`Plugin infra-kit@infra-kit installed (project scope, ${repo})`)
    } finally {
      fs.rmSync(link)
    }
  })

  it('says nothing without a git root or an origin', () => {
    installPlugin()

    expect(
      messageOf(checkClaudePlugin(repo, { projectDir: null, cwd: '/elsewhere', gitRoot: null }), 'plugin installed'),
    ).not.toContain('launch')
    expect(messageOf(checkClaudePlugin(repo), 'plugin installed')).not.toContain('launch')
  })
})

describe('checkClaudeCli', () => {
  it('passes when the binary answers --version', async () => {
    spawnOutcome.reject = false

    const check = await checkClaudeCli()

    expect(check.name).toBe('claude CLI')
    expect(check.status).toBe('pass')
  })

  it('fails, naming the consequence, when the binary is not on PATH', async () => {
    spawnOutcome.reject = true

    const check = await checkClaudeCli()

    expect(check.status).toBe('fail')
    expect(check.message).toContain('claude CLI not found on PATH')
    expect(check.message).toContain('cannot install the plugin')
  })
})

describe('report placement', () => {
  it('puts every new row in the Claude Code plugin section, never Other', async () => {
    spawnOutcome.reject = false

    const sections = groupChecks([
      await checkClaudeCli(),
      ...checkClaudePlugin(repo),
      checkMcpServerKey(repo),
      checkAgentMode({ env: {}, stdinIsTTY: true, flag: false }),
      checkAgentAllowlist(repo),
    ])

    expect(sections).toHaveLength(1)
    expect(sections[0]?.label).toBe('Claude Code plugin')
    expect(sections[0]?.checks).toHaveLength(9)
  })

  it('lists the nine names in the canonical inventory', () => {
    for (const name of [
      'claude CLI',
      'marketplace registered',
      'plugin installed',
      'plugin version',
      'plugin MCP server',
      'CLI version',
      'MCP server key',
      'Agent mode',
      'Agent allowlist',
    ])
      expect(DOCTOR_CHECK_NAMES).toContain(name)
  })

  /** `claude CLI` is a report, not a verdict: only `plugin installed` drives doctor's exit code. */
  it('places claude CLI first, ahead of the rows its absence explains', () => {
    const plugin = DOCTOR_CHECK_NAMES.slice(-9)

    expect(plugin[0]).toBe('claude CLI')
  })
})
