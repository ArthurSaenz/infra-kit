import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PACKAGE_MARKER_END, PACKAGE_MARKER_START, ROOT_MARKER_START, resetAdoptionCache } from 'src/lib/agent-guidance'

import { audit } from '../audit'
import { captureLog } from './helpers/capture-log'

/**
 * The repo root `--all` / `--root` and the fix branch resolve to. Mocked rather than driven by a
 * temp git repo because `getProjectRoot` shells out through zx, whose `$` does not follow
 * `process.chdir` — a chdir'd fixture would silently write into THIS repo instead.
 */
const projectRoot = vi.hoisted(() => {
  return { value: '' }
})

vi.mock('src/lib/git-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/git-utils')>()

  return {
    ...actual,
    getProjectRoot: async () => {
      return projectRoot.value
    },
  }
})

const tmpDirs: string[] = []

/** Every package the fixture declares, relative to the workspace root, in discovery order. */
const FIXTURE_PACKAGES = ['apps/demo/api', 'apps/demo/tests', 'apps/demo/ui', 'packages/lib-a'] as const

/** The package type each fixture package must resolve to — one per body, all four distinct. */
const EXPECTED_TYPES: Readonly<Record<(typeof FIXTURE_PACKAGES)[number], string>> = {
  'apps/demo/api': 'backend',
  'apps/demo/tests': 'e2e',
  'apps/demo/ui': 'frontend',
  'packages/lib-a': 'lib',
}

/* eslint-disable sonarjs/no-os-command-from-path -- hermetic test fixture drives the real `git` CLI */
/**
 * Make `dir` a git repo. The package backup policy is git-aware, so a non-repo fixture would
 * exercise a different branch of `writeManaged` than a real consumer ever hits.
 */
const gitInit = (dir: string): void => {
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'fixture'], {
    cwd: dir,
    stdio: 'ignore',
  })
}
/* eslint-enable sonarjs/no-os-command-from-path */

/**
 * A pnpm workspace holding one package per {@link EXPECTED_TYPES} entry, committed to git.
 * Realpath'd so the paths the fix reports match the ones the fixture wrote (macOS maps
 * /var → /private/var).
 */
const makeWorkspace = (): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-')))

  tmpDirs.push(root)
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*/*\n  - packages/*\n')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ws-root', type: 'module' }))
  fs.writeFileSync(
    path.join(root, 'infra-kit.json'),
    JSON.stringify({ envManagement: { provider: 'doppler', config: { name: 'ws-root' } } }),
  )
  fs.writeFileSync(
    path.join(root, 'infra-kit.config.ts'),
    'export default { requiredScripts: [], requiredFiles: [], turbo: { requiredTasks: [] } }',
  )
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# root notes\n')

  for (const relDir of FIXTURE_PACKAGES) {
    const dir = path.join(root, relDir)

    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@ws/${path.basename(relDir)}` }))
    fs.writeFileSync(path.join(dir, 'infra-kit.config.ts'), 'export default { requiredScripts: [], requiredFiles: [] }')
  }

  gitInit(root)
  projectRoot.value = root

  return root
}

const readFile = (filePath: string): string => {
  return fs.readFileSync(filePath, 'utf-8')
}

const exists = (filePath: string): boolean => {
  return fs.existsSync(filePath)
}

/** The `fixed` entries of a run, which are absent entirely unless `fix` was set. */
type FixedEntries = NonNullable<Awaited<ReturnType<typeof audit>>['structuredContent']['fixed']>

const fixedFor = (entries: FixedEntries, filePath: string) => {
  return entries.find((entry) => {
    return entry.path === filePath
  })
}

/** The `agent-guidance` check message for one package name. */
const guidanceMessage = (result: Awaited<ReturnType<typeof audit>>, packageName: string): string | undefined => {
  return result.structuredContent.packages
    .find((pkg) => {
      return pkg.name === packageName
    })
    ?.checks.find((check) => {
      return check.name === 'agent-guidance'
    })?.message
}

beforeEach(() => {
  resetAdoptionCache()
})

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()

    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('audit --fix --all', () => {
  it('creates one CLAUDE.md per package, each carrying its own type body', async () => {
    const root = makeWorkspace()

    const result = await audit({ all: true, fix: true })
    const fixed = result.structuredContent.fixed ?? []

    expect(fixed).toHaveLength(FIXTURE_PACKAGES.length)

    const bodies = new Set<string>()

    for (const relDir of FIXTURE_PACKAGES) {
      const claudePath = path.join(root, relDir, 'CLAUDE.md')
      const entry = fixedFor(fixed, claudePath)

      expect(entry, `${relDir} must be reported`).toMatchObject({ action: 'created', type: EXPECTED_TYPES[relDir] })
      expect(exists(claudePath)).toBe(true)
      bodies.add(readFile(claudePath))
    }

    // Four packages, four distinct bodies — the type is what selects the rules, so two packages
    // of different types must never render the same block.
    expect(bodies.size).toBe(FIXTURE_PACKAGES.length)
  })

  it('reports every file unchanged on a second run and rewrites nothing', async () => {
    const root = makeWorkspace()

    await audit({ all: true, fix: true })

    const before = FIXTURE_PACKAGES.map((relDir) => {
      return readFile(path.join(root, relDir, 'CLAUDE.md'))
    })

    resetAdoptionCache()

    const lines = await captureLog(() => {
      return audit({ all: true, fix: true })
    })

    const after = FIXTURE_PACKAGES.map((relDir) => {
      return readFile(path.join(root, relDir, 'CLAUDE.md'))
    })

    expect(after).toEqual(before)
    expect(lines).toContainEqual(expect.stringMatching(/^Agent guidance synced — 4 unchanged, 0 created \(infra-kit /u))
  })

  it('preserves hand-authored prose above and below the managed block', async () => {
    const root = makeWorkspace()
    const claudePath = path.join(root, 'packages/lib-a/CLAUDE.md')

    fs.writeFileSync(
      claudePath,
      `ABOVE THE BLOCK\n\n${PACKAGE_MARKER_START}\nstale body\n${PACKAGE_MARKER_END}\n\nBELOW THE BLOCK\n`,
    )

    await audit({ all: true, fix: true })

    const content = readFile(claudePath)

    expect(content).toContain('ABOVE THE BLOCK')
    expect(content).toContain('BELOW THE BLOCK')
    expect(content).not.toContain('stale body')
    expect(content.indexOf('ABOVE THE BLOCK')).toBeLessThan(content.indexOf(PACKAGE_MARKER_START))
    expect(content.indexOf('BELOW THE BLOCK')).toBeGreaterThan(content.indexOf(PACKAGE_MARKER_END))
  })

  it('leaves the repo-root CLAUDE.md untouched', async () => {
    const root = makeWorkspace()
    const rootClaude = path.join(root, 'CLAUDE.md')
    const before = readFile(rootClaude)

    await audit({ all: true, fix: true })

    expect(readFile(rootClaude)).toBe(before)
    expect(readFile(rootClaude)).not.toContain(ROOT_MARKER_START)
  })

  it('repairs before it reports, so a block it just created audits as present', async () => {
    makeWorkspace()

    const result = await audit({ all: true, fix: true })

    expect(result.structuredContent.allPassed).toBe(true)
    expect(guidanceMessage(result, '@ws/ui')).toMatch(/^present \(block from infra-kit .+, type frontend\)$/u)
  })
})

describe('audit --fix --root', () => {
  it('writes the root block and touches no package file', async () => {
    const root = makeWorkspace()

    const result = await audit({ root: true, fix: true })
    const fixed = result.structuredContent.fixed ?? []

    expect(readFile(path.join(root, 'CLAUDE.md'))).toContain(ROOT_MARKER_START)
    expect(fixedFor(fixed, path.join(root, 'CLAUDE.md'))?.action).toBe('updated')

    for (const relDir of FIXTURE_PACKAGES) {
      expect(exists(path.join(root, relDir, 'CLAUDE.md')), `${relDir} must be untouched`).toBe(false)
    }
  })
})

describe('audit --fix with no scope flag', () => {
  it('writes only the package walked up from cwd', async () => {
    const root = makeWorkspace()
    const target = path.join(root, 'apps/demo/ui')

    const result = await audit({ cwd: target, fix: true })
    const fixed = result.structuredContent.fixed ?? []

    expect(fixed).toHaveLength(1)
    expect(fixedFor(fixed, path.join(target, 'CLAUDE.md'))).toMatchObject({ action: 'created', type: 'frontend' })

    for (const relDir of FIXTURE_PACKAGES.filter((dir) => {
      return dir !== 'apps/demo/ui'
    })) {
      expect(exists(path.join(root, relDir, 'CLAUDE.md')), `${relDir} must be untouched`).toBe(false)
    }

    expect(readFile(path.join(root, 'CLAUDE.md'))).not.toContain(ROOT_MARKER_START)
  })
})

describe('audit --fix --design', () => {
  it('scaffolds DESIGN.md for the frontend package only', async () => {
    const root = makeWorkspace()

    await audit({ all: true, fix: true, design: true })

    expect(exists(path.join(root, 'apps/demo/ui/DESIGN.md'))).toBe(true)

    for (const relDir of ['apps/demo/api', 'apps/demo/tests', 'packages/lib-a']) {
      expect(exists(path.join(root, relDir, 'DESIGN.md')), `${relDir} owns no visual language`).toBe(false)
    }
  })

  it('never overwrites an existing DESIGN.md', async () => {
    const root = makeWorkspace()
    const designPath = path.join(root, 'apps/demo/ui/DESIGN.md')

    fs.writeFileSync(designPath, 'HAND WRITTEN DESIGN NOTES\n')

    const result = await audit({ all: true, fix: true, design: true })

    expect(readFile(designPath)).toBe('HAND WRITTEN DESIGN NOTES\n')
    expect(fixedFor(result.structuredContent.fixed ?? [], designPath)).toBeUndefined()
  })
})

describe('audit --fix — per-file failure', () => {
  /** A `CLAUDE.md` that is a dangling symlink: `writeManaged` refuses to follow it. */
  const plantDanglingSymlink = (packageDir: string): string => {
    const claudePath = path.join(packageDir, 'CLAUDE.md')

    fs.symlinkSync(path.join(packageDir, 'nowhere-at-all.md'), claudePath)

    return claudePath
  }

  it('continues past the failure, writes every other package, and reports the failed path', async () => {
    const root = makeWorkspace()
    const broken = plantDanglingSymlink(path.join(root, 'apps/demo/api'))

    const result = await audit({ all: true, fix: true })
    const fixed = result.structuredContent.fixed ?? []

    expect(fixedFor(fixed, broken)).toMatchObject({ action: 'failed', type: 'backend' })

    for (const relDir of ['apps/demo/tests', 'apps/demo/ui', 'packages/lib-a']) {
      expect(fixedFor(fixed, path.join(root, relDir, 'CLAUDE.md'))?.action, `${relDir} still written`).toBe('created')
    }

    // The three successful writes ADOPT the workspace, so the package the run could not write
    // now legitimately fails its own check. The pre-adoption case — where the failure is
    // invisible to the audit and only `fixed[]` records it — is the next test.
    expect(result.structuredContent.allPassed).toBe(false)
  })

  it('reports a failed write while the audit itself passes, before adoption', async () => {
    const root = makeWorkspace()
    const target = path.join(root, 'apps/demo/ui')
    const broken = plantDanglingSymlink(target)

    const result = await audit({ cwd: target, fix: true })

    // No package anywhere carries a block, so the workspace stays unadopted and a `missing`
    // CLAUDE.md PASSES. Without `fixed[]` this run would report green and exit 0 — which is
    // exactly why `program.ts` reds the exit code on a failed entry.
    expect(result.structuredContent.allPassed).toBe(true)
    expect(fixedFor(result.structuredContent.fixed ?? [], broken)).toMatchObject({ action: 'failed' })
    expect(guidanceMessage(result, '@ws/ui')).toContain('not yet adopted')
  })
})

describe('audit --fix — adoption flip', () => {
  const FLIP_LINE = 'workspace adopted — every other package now needs a CLAUDE.md: run infra-kit audit --fix --all'

  it('warns when a single-package fix adopts a previously unadopted workspace', async () => {
    const root = makeWorkspace()

    const lines = await captureLog(() => {
      return audit({ cwd: path.join(root, 'apps/demo/ui'), fix: true })
    })

    expect(lines).toContain(FLIP_LINE)
  })

  it('stays silent for --fix --all, which leaves no package behind', async () => {
    makeWorkspace()

    const lines = await captureLog(() => {
      return audit({ all: true, fix: true })
    })

    expect(lines).not.toContain(FLIP_LINE)
  })
})

describe('audit without --fix', () => {
  it('carries no fixed field at all, so the MCP output schema stays accurate', async () => {
    makeWorkspace()

    const result = await audit({ all: true })

    expect('fixed' in result.structuredContent).toBe(false)
  })
})
