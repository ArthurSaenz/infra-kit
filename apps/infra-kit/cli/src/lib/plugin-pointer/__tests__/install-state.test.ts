import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  inspectMcpRegistration,
  isMarketplaceRegistered,
  readInstalledPluginVersion,
  resolvePluginInstall,
} from '../install-state'

/**
 * Host-state readers. Every case runs against a temp `$HOME`, never the developer's own
 * `~/.claude/plugins/` — a suite whose result depends on whether the author happens to have the
 * plugin installed proves nothing on anyone else's machine, or in CI.
 */

let home: string
let repo: string

const pluginsDir = (): string => {
  return path.join(home, '.claude', 'plugins')
}

const writeJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

const writeInstalled = (entries: unknown[]): void => {
  writeJson(path.join(pluginsDir(), 'installed_plugins.json'), {
    version: 2,
    plugins: { 'playwright@claude-plugins-official': [], 'infra-kit@infra-kit': entries },
  })
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-repo-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('isMarketplaceRegistered', () => {
  it('is false when the file does not exist', () => {
    expect(isMarketplaceRegistered(home)).toBe(false)
  })

  it('is false when the file is unparseable', () => {
    fs.mkdirSync(pluginsDir(), { recursive: true })
    fs.writeFileSync(path.join(pluginsDir(), 'known_marketplaces.json'), '{ broken', 'utf-8')

    expect(isMarketplaceRegistered(home)).toBe(false)
  })

  it('is false when other marketplaces are registered but ours is not', () => {
    writeJson(path.join(pluginsDir(), 'known_marketplaces.json'), {
      'context-mode': { source: { source: 'github', repo: 'mksglu/context-mode' } },
    })

    expect(isMarketplaceRegistered(home)).toBe(false)
  })

  it('is true once the infra-kit marketplace is present', () => {
    writeJson(path.join(pluginsDir(), 'known_marketplaces.json'), {
      'infra-kit': { source: { source: 'github', repo: 'ArthurSaenz/infra-kit' } },
    })

    expect(isMarketplaceRegistered(home)).toBe(true)
  })
})

describe('resolvePluginInstall', () => {
  it('is absent when the file is absent, when the key is absent, and when the array is empty', () => {
    expect(resolvePluginInstall({ home, projectPath: repo })).toEqual({ kind: 'absent' })

    writeJson(path.join(pluginsDir(), 'installed_plugins.json'), { version: 2, plugins: {} })
    expect(resolvePluginInstall({ home, projectPath: repo })).toEqual({ kind: 'absent' })

    writeInstalled([])
    expect(resolvePluginInstall({ home, projectPath: repo })).toEqual({ kind: 'absent' })
  })

  it('counts a user-scope entry as installed for every project', () => {
    writeInstalled([{ scope: 'user', projectPath: null, installPath: '/cache/a', version: '0.4.0' }])

    const state = resolvePluginInstall({ home, projectPath: repo })

    expect(state.kind).toBe('installed')
    expect(state.kind === 'installed' && state.installation.scope).toBe('user')
  })

  it('counts a project-scope entry for THIS root as installed', () => {
    writeInstalled([
      { scope: 'project', projectPath: '/other/repo', installPath: '/cache/a', version: 'a' },
      { scope: 'project', projectPath: repo, installPath: '/cache/b', version: 'b' },
    ])

    const state = resolvePluginInstall({ home, projectPath: repo })

    expect(state.kind).toBe('installed')
    expect(state.kind === 'installed' && state.installation.version).toBe('b')
  })

  /**
   * The live defect this rule exists for: doctor reported a green "plugin installed" row in a repo
   * where the plugin was installed only for an unrelated scratch directory.
   */
  it('is `elsewhere`, NOT installed, when only another project has it', () => {
    writeInstalled([{ scope: 'project', projectPath: '/other/repo', installPath: '/cache/a', version: 'a' }])

    const state = resolvePluginInstall({ home, projectPath: repo })

    expect(state.kind).toBe('elsewhere')
    expect(state.kind === 'elsewhere' && state.installations[0]?.projectPath).toBe('/other/repo')
  })

  it('is `elsewhere` when no project root is supplied and no entry is user-scope', () => {
    writeInstalled([{ scope: 'project', projectPath: '/other/repo', installPath: '/cache/a', version: 'a' }])

    expect(resolvePluginInstall({ home }).kind).toBe('elsewhere')
  })

  it('matches through a symlinked root — realpath on both sides, or neither matches on macOS', () => {
    const link = path.join(path.dirname(repo), `${path.basename(repo)}-link`)

    fs.symlinkSync(repo, link)
    writeInstalled([{ scope: 'project', projectPath: repo, installPath: '/cache/a', version: 'a' }])

    expect(resolvePluginInstall({ home, projectPath: link }).kind).toBe('installed')

    fs.rmSync(link)
  })

  it('accepts a record naming this root whatever scope string it carries', () => {
    writeInstalled([{ projectPath: repo, installPath: '/cache/a', version: 'a' }])

    expect(resolvePluginInstall({ home, projectPath: repo }).kind).toBe('installed')
  })

  it('skips malformed entries instead of throwing', () => {
    writeInstalled(['nonsense', 42, { scope: 'project', projectPath: repo }])

    const state = resolvePluginInstall({ home, projectPath: repo })

    expect(state.kind === 'installed' && state.installation).toEqual({
      scope: 'project',
      projectPath: repo,
      installPath: null,
      version: null,
    })
  })
})

describe('readInstalledPluginVersion', () => {
  it('prefers the plugin manifest over the recorded sha', () => {
    const installPath = path.join(repo, 'cache')

    writeJson(path.join(installPath, '.claude-plugin', 'plugin.json'), { name: 'infra-kit', version: '0.5.1' })

    expect(
      readInstalledPluginVersion({ scope: 'project', projectPath: repo, installPath, version: '85cce0381e78' }),
    ).toBe('0.5.1')
  })

  it('falls back to the recorded version when there is no manifest', () => {
    expect(
      readInstalledPluginVersion({ scope: 'project', projectPath: repo, installPath: '/nowhere', version: 'abc123' }),
    ).toBe('abc123')
  })

  it('is null when neither source has a version', () => {
    expect(
      readInstalledPluginVersion({ scope: 'project', projectPath: repo, installPath: null, version: null }),
    ).toBeNull()
  })
})

describe('inspectMcpRegistration (T4b)', () => {
  const writeMcp = (value: unknown): void => {
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify(value, null, 2), 'utf-8')
  }

  it('reports a missing file', () => {
    expect(inspectMcpRegistration(repo)).toEqual({ kind: 'missing-file' })
  })

  it('reports an unparseable file', () => {
    fs.writeFileSync(path.join(repo, '.mcp.json'), '{ nope', 'utf-8')

    expect(inspectMcpRegistration(repo)).toEqual({ kind: 'unparseable' })
  })

  it('passes on the canonical key', () => {
    writeMcp({
      mcpServers: {
        'infra-kit': { type: 'stdio', command: 'infra-kit', args: ['mcp'] },
        'linear-server': { type: 'http', url: 'https://mcp.linear.app/mcp' },
      },
    })

    expect(inspectMcpRegistration(repo)).toEqual({ kind: 'ok' })
  })

  it('fails, naming the key, when the same server is filed under another name', () => {
    writeMcp({ mcpServers: { ik: { type: 'stdio', command: 'infra-kit', args: ['mcp'] } } })

    expect(inspectMcpRegistration(repo)).toEqual({ kind: 'wrong-key', key: 'ik' })
  })

  it('detects the misfiled server through its args as well as its command', () => {
    writeMcp({
      mcpServers: { tools: { type: 'stdio', command: 'node', args: ['./node_modules/infra-kit/dist/mcp.js'] } },
    })

    expect(inspectMcpRegistration(repo)).toEqual({ kind: 'wrong-key', key: 'tools' })
  })

  it('reports absence when no server resembles infra-kit', () => {
    writeMcp({ mcpServers: { 'linear-server': { type: 'http', url: 'https://mcp.linear.app/mcp' } } })

    expect(inspectMcpRegistration(repo)).toEqual({ kind: 'absent' })
  })
})
