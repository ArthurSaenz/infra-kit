import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkClaudePlugin, checkMcpServerKey } from '../doctor'
import { DOCTOR_CHECK_NAMES, groupChecks } from '../report'

/**
 * O3 and T4(b) — the doctor rows about the Claude Code plugin.
 *
 * `$HOME` is stubbed to a temp dir for every case, so the verdicts come from a fixture rather than
 * from whether the author happens to have the plugin installed. `os.homedir()` reads `HOME` on
 * POSIX, which is what makes the stub reach the readers without threading a seam through the checks.
 */

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

const installPlugin = (): string => {
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'infra-kit')

  writeJson(path.join(installPath, '.claude-plugin', 'plugin.json'), { name: 'infra-kit', version: '0.4.0' })
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
  it('emits the four rows in order, whatever the host state', () => {
    expect(
      checkClaudePlugin(repo).map((check) => {
        return check.name
      }),
    ).toEqual(['marketplace registered', 'plugin installed', 'plugin version', 'CLI version'])
  })

  it('fails marketplace, install and version on a machine that has none of it', () => {
    const checks = checkClaudePlugin(repo)

    expect(statusOf(checks, 'marketplace registered')).toBe('fail')
    expect(statusOf(checks, 'plugin installed')).toBe('fail')
    expect(statusOf(checks, 'plugin version')).toBe('fail')
    expect(messageOf(checks, 'marketplace registered')).toContain('claude plugin marketplace add ArthurSaenz/infra-kit')
    expect(messageOf(checks, 'plugin installed')).toContain('claude plugin install infra-kit@infra-kit --scope project')
  })

  it('passes all four once the marketplace is registered and the plugin installed', () => {
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

describe('checkMcpServerKey (T4b)', () => {
  const writeMcp = (value: unknown): void => {
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify(value, null, 2), 'utf-8')
  }

  it('passes on the canonical key', () => {
    writeMcp({ mcpServers: { 'infra-kit': { type: 'stdio', command: 'infra-kit', args: ['mcp'] } } })

    expect(checkMcpServerKey(repo).status).toBe('pass')
  })

  it('fails and names the expected prefix when the server is filed under another key', () => {
    writeMcp({ mcpServers: { ik: { type: 'stdio', command: 'infra-kit', args: ['mcp'] } } })

    const check = checkMcpServerKey(repo)

    expect(check.status).toBe('fail')
    expect(check.message).toContain('"ik"')
    expect(check.message).toContain('mcp__infra-kit__')
  })

  it('fails, naming the prefix, when there is no infra-kit server at all', () => {
    writeMcp({ mcpServers: { 'linear-server': { type: 'http', url: 'https://mcp.linear.app/mcp' } } })

    const check = checkMcpServerKey(repo)

    expect(check.status).toBe('fail')
    expect(check.message).toContain('mcp__infra-kit__')
  })

  /**
   * A repo with no `.mcp.json` has abstained from MCP entirely and has no key to get wrong, so this
   * row states that and does not fail. A file that IS present without the key is the misconfiguration
   * the check exists for, and that case above stays red.
   */
  it('passes with a not-applicable note when there is no .mcp.json', () => {
    const check = checkMcpServerKey(repo)

    expect(check.status).toBe('pass')
    expect(check.message).toContain('Not applicable: no .mcp.json')
  })
})

describe('report placement', () => {
  it('puts every new row in the Claude Code plugin section, never Other', () => {
    const sections = groupChecks([...checkClaudePlugin(repo), checkMcpServerKey(repo)])

    expect(sections).toHaveLength(1)
    expect(sections[0]?.label).toBe('Claude Code plugin')
    expect(sections[0]?.checks).toHaveLength(5)
  })

  it('lists the five names in the canonical inventory', () => {
    for (const name of [
      'marketplace registered',
      'plugin installed',
      'plugin version',
      'CLI version',
      'MCP server key',
    ])
      expect(DOCTOR_CHECK_NAMES).toContain(name)
  })
})
