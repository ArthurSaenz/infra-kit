import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { LEGACY_MCP_TOOL_PREFIX, MCP_TOOL_PREFIX, prefixFor, resolveLaunch } from '../tool-prefix'

const CLI_ROOT = path.resolve(import.meta.dirname, '../../..')
const REPO_ROOT = path.resolve(CLI_ROOT, '../../..')
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins/infra-kit')

/** The one file allowed to spell either prefix, relative to the CLI package root. */
const PREFIX_MODULE = 'src/mcp/tool-prefix.ts'

/**
 * Every file under `dir`, relative to `CLI_ROOT`, skipping the directories whose contents are not
 * shipped: tests and fixtures may quote either spelling to assert against it.
 */
const shippedFiles = (dir: string): string[] => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === '__fixtures__' ? [] : shippedFiles(full)
    }

    return [path.relative(CLI_ROOT, full)]
  })
}

const readJson = (file: string): Record<string, unknown> => {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** The server key the plugin's retired `.mcp.json` carried — the same key a consumer's own entry uses. */
const SERVER_KEY = 'infra-kit'

describe('mCP_TOOL_PREFIX against the plugin on disk', () => {
  /**
   * Claude Code names a plugin-spawned server's tools `mcp__plugin_<plugin>_<server>__<tool>`, where
   * `<plugin>` is `plugin.json`'s `name`. The plugin is skills-only now: it has NO `.mcp.json`, so the
   * `<server>` half is the literal key the retired file carried, and this test pins BOTH halves — the
   * name to the manifest, and the absence of the file. A plugin that grows a `.mcp.json` again is a
   * red test here, not a silently re-composed prefix.
   */
  it('has no .mcp.json in the plugin — the skills drive the CLI, not an MCP server', () => {
    const mcpJson = path.join(PLUGIN_ROOT, '.mcp.json')

    expect(fs.existsSync(mcpJson), `${mcpJson} exists — the plugin is skills-only`).toBe(false)
  })

  it('equals mcp__plugin_<plugin.json name>_<literal server key>__', () => {
    const { name } = readJson(path.join(PLUGIN_ROOT, '.claude-plugin/plugin.json'))

    expect(typeof name).toBe('string')
    expect(MCP_TOOL_PREFIX).toBe(`mcp__plugin_${name as string}_${SERVER_KEY}__`)
  })

  it('and the legacy prefix is the one a consumer `.mcp.json` key of `infra-kit` produces', () => {
    // The key is the same `infra-kit` on both routes; only the plugin route wraps it.
    expect(LEGACY_MCP_TOOL_PREFIX).toBe(`mcp__${SERVER_KEY}__`)
    expect(MCP_TOOL_PREFIX).not.toBe(LEGACY_MCP_TOOL_PREFIX)
  })
})

describe('resolveLaunch', () => {
  it('reads the plugin launch from a set CLAUDE_PLUGIN_ROOT', () => {
    expect(resolveLaunch({ CLAUDE_PLUGIN_ROOT: '/x' })).toBe('plugin')
  })

  it('reads the legacy launch from an absent or empty CLAUDE_PLUGIN_ROOT', () => {
    expect(resolveLaunch({})).toBe('legacy')
    expect(resolveLaunch({ CLAUDE_PLUGIN_ROOT: '' })).toBe('legacy')
  })

  it('reads nothing else from the environment', () => {
    // A plugin-shaped environment without the one signal is still the legacy route.
    expect(resolveLaunch({ CLAUDE_PROJECT_DIR: '/repo', CLAUDE_PLUGIN_ROOT: undefined })).toBe('legacy')
  })
})

describe('prefixFor', () => {
  it('spells the prefix for the route that spawned the server', () => {
    expect(prefixFor('plugin')).toBe(MCP_TOOL_PREFIX)
    expect(prefixFor('legacy')).toBe(LEGACY_MCP_TOOL_PREFIX)
  })
})

describe('the negative grep — one spelling per prefix (P6)', () => {
  /**
   * Every module that needs a prefix imports it. A second literal is a second place to update when
   * the server goes (plan §3.11 Phase 3), and — worse — a place that keeps spelling the
   * old prefix into a served string after the constant has moved on. The allowed-hit list is exact,
   * so a new literal anywhere shipped is a red test naming the file, not a grep somebody has to
   * remember to run.
   */
  it('spells the legacy prefix in tool-prefix.ts and nowhere else shipped', () => {
    const hits = [
      ...shippedFiles(path.join(CLI_ROOT, 'src')),
      ...shippedFiles(path.join(CLI_ROOT, 'resources')),
    ].filter((file) => {
      return fs.readFileSync(path.join(CLI_ROOT, file), 'utf8').includes(LEGACY_MCP_TOOL_PREFIX)
    })

    expect(hits).toEqual([PREFIX_MODULE])
  })

  /**
   * The served Markdown that once carried the canonical literal (prettier-owned, so no template token)
   * moved to the plugin's skills; everything left in `src/` and `resources/` composes it from the
   * constant.
   */
  it('spells the canonical prefix in tool-prefix.ts and nowhere else shipped', () => {
    const hits = [
      ...shippedFiles(path.join(CLI_ROOT, 'src')),
      ...shippedFiles(path.join(CLI_ROOT, 'resources')),
    ].filter((file) => {
      return fs.readFileSync(path.join(CLI_ROOT, file), 'utf8').includes(MCP_TOOL_PREFIX)
    })

    expect(hits).toEqual([PREFIX_MODULE])
  })
})
