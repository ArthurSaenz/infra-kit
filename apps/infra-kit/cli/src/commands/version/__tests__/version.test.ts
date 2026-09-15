import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { LEGACY_MCP_TOOL_PREFIX, MCP_TOOL_PREFIX } from 'src/mcp/tool-prefix'

import packageJson from '../../../../package.json' with { type: 'json' }
import { version, versionMcpTool } from '../version'

/**
 * The `version` tool's location and route fields (plan docs/archive/mcp/mcp-via-plugin-migration-plan.md §4
 * PM-4, §3.3): what the doctor skill reads to tell a worktree session from the main checkout and a
 * plugin-spawned server from a legacy one. Git is mocked at the seam: the fields are the seam's
 * answers passed through (or `null`), and a real `git` here would make the verdict depend on where
 * vitest was launched.
 */

vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn(), getMainRepoRoot: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

beforeEach(() => {
  vi.mocked(getProjectRoot).mockResolvedValue('/repo/wt/feature')
  vi.mocked(getMainRepoRoot).mockResolvedValue('/repo')
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', '')
  vi.stubEnv('CLAUDE_PROJECT_DIR', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('version — structuredContent', () => {
  it('reports the package version, the cwd and both git roots', async () => {
    const { structuredContent } = await version()

    expect(structuredContent.version).toBe(packageJson.version)
    expect(structuredContent.cwd).toBe(process.cwd())
    expect(structuredContent.repoRoot).toBe('/repo/wt/feature')
    expect(structuredContent.mainRepoRoot).toBe('/repo')
    // The main root is asked about the RESOLVED root, so a worktree answers its main checkout.
    expect(getMainRepoRoot).toHaveBeenCalledWith('/repo/wt/feature')
  })

  it('reports CLAUDE_PROJECT_DIR when set, null when unset or blank', async () => {
    expect((await version()).structuredContent.projectDir).toBeNull()

    vi.stubEnv('CLAUDE_PROJECT_DIR', '/repo')

    expect((await version()).structuredContent.projectDir).toBe('/repo')
  })

  it('reports the plugin route and prefix when CLAUDE_PLUGIN_ROOT is set', async () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/home/me/.claude/plugins/cache/infra-kit/infra-kit/0.8.0')

    const { structuredContent } = await version()

    expect(structuredContent.launch).toBe('plugin')
    expect(structuredContent.toolPrefix).toBe(MCP_TOOL_PREFIX)
  })

  it('reports the legacy route and prefix when CLAUDE_PLUGIN_ROOT is unset', async () => {
    const { structuredContent } = await version()

    expect(structuredContent.launch).toBe('legacy')
    expect(structuredContent.toolPrefix).toBe(LEGACY_MCP_TOOL_PREFIX)
  })

  it('answers repoRoot: null (and mainRepoRoot: null) when git cannot resolve, without throwing', async () => {
    vi.mocked(getProjectRoot).mockRejectedValue(new Error('fatal: not a git repository'))

    const { structuredContent } = await version()

    expect(structuredContent.repoRoot).toBeNull()
    expect(structuredContent.mainRepoRoot).toBeNull()
    expect(structuredContent.version).toBe(packageJson.version)
    expect(getMainRepoRoot).not.toHaveBeenCalled()
  })

  it('answers mainRepoRoot: null when only the main-root lookup fails', async () => {
    vi.mocked(getMainRepoRoot).mockRejectedValue(new Error('fatal: --git-common-dir'))

    const { structuredContent } = await version()

    expect(structuredContent.repoRoot).toBe('/repo/wt/feature')
    expect(structuredContent.mainRepoRoot).toBeNull()
  })

  it('keeps content and structuredContent in step', async () => {
    const result = await version()

    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent)
  })
})

describe('version — outputSchema', () => {
  it('validates every field the handler emits, nullable roots included', async () => {
    const schema = versionMcpTool.outputSchema

    expect(schema).toBeDefined()

    const parsed = await version()

    for (const [key, field] of Object.entries(schema ?? {})) {
      expect(field.safeParse(parsed.structuredContent[key as keyof typeof parsed.structuredContent]).success, key).toBe(
        true,
      )
    }

    vi.mocked(getProjectRoot).mockRejectedValue(new Error('no git'))

    const nulled = await version()

    expect(schema?.repoRoot?.safeParse(nulled.structuredContent.repoRoot).success).toBe(true)
    expect(schema?.mainRepoRoot?.safeParse(nulled.structuredContent.mainRepoRoot).success).toBe(true)
  })

  it('documents exactly the emitted keys', async () => {
    const { structuredContent } = await version()

    expect(Object.keys(versionMcpTool.outputSchema ?? {}).sort()).toEqual(Object.keys(structuredContent).sort())
  })
})
