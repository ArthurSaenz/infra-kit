import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildUserProjectExample } from 'src/lib/config-templates'
// Imported AFTER the hoisted mock factory below, so the module under test sees the fakes.
import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'
import { resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import { configEdit, configPath } from '../config'

vi.mock('src/lib/git-utils', () => {
  return {
    getProjectRoot: vi.fn(),
    getRepoName: vi.fn(),
    getMainRepoRoot: vi.fn(),
  }
})

const zx = vi.hoisted(() => {
  return { calls: [] as unknown[][] }
})

vi.mock('zx', () => {
  return {
    $: vi.fn(() => {
      return (_strings: TemplateStringsArray, ...values: unknown[]) => {
        zx.calls.push(values)

        return Promise.resolve({ stdout: '' })
      }
    }),
  }
})

let home: string
let repo: string
let repoName: string
let userProjectDir: string
let userProjectConfig: string
let infoSpy: ReturnType<typeof vi.spyOn>

/** Structured shape of `configPath`'s `--json` payload — the shipped stdout contract. */
interface ConfigPathContent {
  projectName: string
  layers: { label: string; path: string; exists: boolean }[]
  hasOverrides: boolean
  overrideKeys: string[]
}

const runConfigPath = async (): Promise<ConfigPathContent> => {
  const result = await configPath()

  return result.structuredContent as unknown as ConfigPathContent
}

const writeUserProject = (content: string): void => {
  fs.mkdirSync(userProjectDir, { recursive: true })
  fs.writeFileSync(userProjectConfig, content)
}

const humanLines = (): string[] => {
  return infoSpy.mock.calls.map((call: unknown[]) => {
    return String(call[0])
  })
}

const userProjectLine = (): string => {
  return humanLines().find((line) => {
    return line.includes('user project')
  }) as string
}

beforeEach(() => {
  vi.clearAllMocks()
  zx.calls.length = 0

  home = fs.mkdtempSync(path.join(os.tmpdir(), 'config-cmd-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'config-cmd-repo-'))
  repoName = path.basename(repo)
  userProjectDir = path.join(home, '.infra-kit', 'projects', repoName)
  userProjectConfig = path.join(userProjectDir, 'infra-kit.json')

  // Load-bearing: `configEdit` calls the UNGATED `seedUserProjectConfig`, which `INFRA_KIT_NO_SEED`
  // (armed globally in vitest.setup.ts) does NOT guard. Without this stub the test writes into the
  // developer's real $HOME.
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.mocked(getProjectRoot).mockResolvedValue(repo)
  vi.mocked(getMainRepoRoot).mockResolvedValue(repo)

  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})

  resetInfraKitConfigCache()
})

afterEach(() => {
  // Load-bearing HERE, not at the end of the test body: an assertion that throws mid-test would skip
  // an in-body `unstubAllEnvs()` and leak the `EDITOR` stub into every later test.
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetInfraKitConfigCache()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('configPath', () => {
  it('reports a just-seeded empty layer-3 as existing but carrying no overrides', async () => {
    writeUserProject('{}\n')

    const content = await runConfigPath()

    expect(content.layers.at(-1)?.exists).toBe(true)
    expect(content.hasOverrides).toBe(false)
    expect(content.overrideKeys).toEqual([])
    expect(userProjectLine()).toContain('(empty — no overrides)')
  })

  it('lists the raw top-level keys of a layer-3 that carries real overrides', async () => {
    writeUserProject(JSON.stringify({ ide: { name: 'zed' }, dev: { api: { port: 3000 } } }))

    const content = await runConfigPath()

    expect(content.hasOverrides).toBe(true)
    expect(content.overrideKeys).toEqual(['ide', 'dev'])
    expect(userProjectLine()).toContain('(2 override(s): ide, dev)')
  })

  it('reports an absent layer-3 with the [ ] marker and no overrides', async () => {
    const content = await runConfigPath()

    expect(content.layers.at(-1)?.exists).toBe(false)
    expect(content.hasOverrides).toBe(false)
    expect(content.overrideKeys).toEqual([])
    expect(userProjectLine()).toContain('[ ]')
  })

  it('degrades instead of throwing when the layer-3 file is malformed JSON', async () => {
    writeUserProject('{ not json')

    const content = await runConfigPath()

    expect(content.layers.at(-1)?.exists).toBe(true)
    expect(content.hasOverrides).toBe(false)
    expect(content.overrideKeys).toEqual([])
    expect(userProjectLine()).toContain('(unreadable — invalid JSON)')
  })

  it.each([
    ['an array', '[1,2,3]'],
    ['a bare string', '"x"'],
    ['a bare null', 'null'],
  ])('reports a layer-3 that parses to %s as unreadable, never as fake override keys', async (_label, content) => {
    writeUserProject(content)

    const rendered = await runConfigPath()

    expect(rendered.hasOverrides).toBe(false)
    // The array case is the sharp one: `Object.keys([1,2,3])` is `['0','1','2']`, which used to print
    // as `(3 override(s): 0, 1, 2)`.
    expect(rendered.overrideKeys).toEqual([])
    expect(userProjectLine()).toContain('(unreadable — invalid JSON)')
  })

  it('surfaces an unknown/typo-d top-level key instead of letting a strict schema swallow it', async () => {
    writeUserProject(JSON.stringify({ devServersPreset: {} }))

    const content = await runConfigPath()

    expect(content.hasOverrides).toBe(true)
    expect(content.overrideKeys).toEqual(['devServersPreset'])
  })

  it('keeps layers[].exists meaning file existence for every layer', async () => {
    fs.writeFileSync(path.join(repo, 'infra-kit.json'), '{}\n')
    writeUserProject('{}\n')

    const content = await runConfigPath()

    expect(
      content.layers.map((layer) => {
        return { label: layer.label, exists: layer.exists }
      }),
    ).toEqual([
      { label: 'project (committed)', exists: true },
      // Never created in this throwaway home — proves `exists` is still a plain fs check.
      { label: 'user global', exists: false },
      { label: 'user project', exists: true },
    ])
  })
})

describe('configEdit', () => {
  it('creates the empty config plus its annotated example on the first run, then opens $EDITOR', async () => {
    vi.stubEnv('EDITOR', 'test-editor')

    const result = await configEdit()

    expect(fs.readFileSync(userProjectConfig, 'utf-8')).toBe('{}\n')
    expect(fs.readFileSync(path.join(userProjectDir, 'infra-kit.example.jsonc'), 'utf-8')).toBe(
      buildUserProjectExample(repoName),
    )
    expect(zx.calls).toEqual([['test-editor', userProjectConfig]])
    expect(result.structuredContent).toEqual({ path: userProjectConfig, editor: 'test-editor' })
  })
})
