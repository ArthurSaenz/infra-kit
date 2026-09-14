import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  LEGACY_MCP_TOOL_PREFIX,
  MCP_TOOL_PREFIX,
  prefixFor,
  renderForLaunch,
  resolveLaunch,
  toolName,
} from '../tool-prefix'
import { WORKFLOW_BODIES } from '../workflow-bodies'

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

/** Every `mcp__…` token in `text` (a prefix plus the tool name that follows it), in order. */
const mcpTokens = (text: string): string[] => {
  return [...text.matchAll(/mcp__[\w-]+/gu)].map((match) => {
    return match[0]
  })
}

describe('mCP_TOOL_PREFIX is composed from the two plugin files on disk', () => {
  /**
   * Claude Code names a plugin-spawned server's tools `mcp__plugin_<plugin>_<server>__<tool>`, where
   * `<plugin>` is `plugin.json`'s `name` and `<server>` the key in the plugin's `.mcp.json`. The
   * constant is a literal (it has to be — it is substituted into Markdown), so nothing but this test
   * ties it to those files: a renamed plugin or a re-keyed server would otherwise ship bodies naming a
   * prefix no session has.
   *
   * A missing `.mcp.json` is a FAILURE, not a skip: the plugin cannot spawn the server without it,
   * and a skipped test here would be the only green in a repo where the constant pins nothing.
   */
  it('equals mcp__plugin_<plugin.json name>_<.mcp.json server key>__', () => {
    const pluginJson = path.join(PLUGIN_ROOT, '.claude-plugin/plugin.json')
    const mcpJson = path.join(PLUGIN_ROOT, '.mcp.json')

    expect(fs.existsSync(mcpJson), `${mcpJson} is missing — the plugin declares no MCP server`).toBe(true)

    const { name } = readJson(pluginJson)
    const { mcpServers } = readJson(mcpJson)

    expect(typeof name).toBe('string')
    expect(mcpServers).toBeTypeOf('object')

    const keys = Object.keys(mcpServers as Record<string, unknown>)

    expect(keys).toHaveLength(1)
    expect(MCP_TOOL_PREFIX).toBe(`mcp__plugin_${name as string}_${keys[0]}__`)
  })

  it('and the legacy prefix is the one a consumer `.mcp.json` key of `infra-kit` produces', () => {
    // The key is the same `infra-kit` on both routes; only the plugin route wraps it.
    expect(LEGACY_MCP_TOOL_PREFIX).toBe('mcp__infra-kit__')
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

describe('prefixFor / toolName', () => {
  it('spell a tool for the route that spawned the server', () => {
    expect(prefixFor('plugin')).toBe(MCP_TOOL_PREFIX)
    expect(prefixFor('legacy')).toBe(LEGACY_MCP_TOOL_PREFIX)
    expect(toolName('release-create', 'plugin')).toBe(`${MCP_TOOL_PREFIX}release-create`)
    expect(toolName('release-create', 'legacy')).toBe(`${LEGACY_MCP_TOOL_PREFIX}release-create`)
  })
})

describe('renderForLaunch', () => {
  const body = [
    `Call ${MCP_TOOL_PREFIX}env-load, then ${MCP_TOOL_PREFIX}env-status.`,
    'A bare `env-load` and the word plugin_infra-kit stay as they are.',
    `And ${MCP_TOOL_PREFIX}env-clear once more.`,
  ].join('\n')

  it('serves the plugin launch the canonical bytes unchanged', () => {
    expect(renderForLaunch(body, 'plugin')).toBe(body)
  })

  it('replaces EVERY canonical prefix for the legacy launch and nothing else', () => {
    const rendered = renderForLaunch(body, 'legacy')

    expect(rendered).toBe(
      [
        `Call ${LEGACY_MCP_TOOL_PREFIX}env-load, then ${LEGACY_MCP_TOOL_PREFIX}env-status.`,
        'A bare `env-load` and the word plugin_infra-kit stay as they are.',
        `And ${LEGACY_MCP_TOOL_PREFIX}env-clear once more.`,
      ].join('\n'),
    )
    expect(rendered).not.toContain(MCP_TOOL_PREFIX)
  })

  it('is pure — the same input and launch always give the same output', () => {
    expect(renderForLaunch(body, 'legacy')).toBe(renderForLaunch(body, 'legacy'))
  })

  /**
   * The soundness of one `replaceAll`: the prefix ends in `__` and every tool name follows it
   * directly, so it cannot occur inside another token. Asserted on the REAL bodies, both ways —
   * every `mcp__` token in the source is canonical, and every one in the legacy render is legacy.
   */
  it.each(Object.keys(WORKFLOW_BODIES) as (keyof typeof WORKFLOW_BODIES)[])(
    'spells every mcp__ token in the %s body for exactly one route',
    (key) => {
      const source = mcpTokens(WORKFLOW_BODIES[key])
      const legacy = mcpTokens(renderForLaunch(WORKFLOW_BODIES[key], 'legacy'))

      // Every body names at least one tool, or the render would be proven on nothing.
      expect(source.length).toBeGreaterThan(0)
      expect(legacy).toHaveLength(source.length)

      for (const token of source) expect(token.startsWith(MCP_TOOL_PREFIX), token).toBe(true)
      for (const token of legacy) expect(token.startsWith(LEGACY_MCP_TOOL_PREFIX), token).toBe(true)
    },
  )
})

describe('the negative grep — one spelling per prefix (P6)', () => {
  /**
   * Every module that needs a prefix imports it. A second literal is a second place to update when
   * the legacy branch is deleted (plan §9 follow-up 1), and — worse — a place that keeps spelling the
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
   * The canonical prefix may be spelled in one more place than the legacy one: the served Markdown,
   * which prettier owns and which therefore carries the literal rather than a template token
   * (docs/mcp-via-plugin-migration-plan.md §3.3). Everything else in `src/` composes it from the
   * constant.
   */
  it('spells the canonical prefix in tool-prefix.ts and the workflow bodies only', () => {
    const hits = [
      ...shippedFiles(path.join(CLI_ROOT, 'src')),
      ...shippedFiles(path.join(CLI_ROOT, 'resources')),
    ].filter((file) => {
      return fs.readFileSync(path.join(CLI_ROOT, file), 'utf8').includes(MCP_TOOL_PREFIX)
    })

    expect(hits.sort()).toEqual([
      'resources/workflow/release-create.md',
      'resources/workflow/session.md',
      'resources/workflow/setup.md',
      PREFIX_MODULE,
    ])
  })
})
