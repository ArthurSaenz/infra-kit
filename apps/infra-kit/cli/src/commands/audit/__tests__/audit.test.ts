import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetAdoptionCache } from 'src/lib/agent-guidance'

import { audit, auditMcpTool } from '../audit'
import { captureLog } from './helpers/capture-log'

/**
 * The repo root `--all` / `--root` resolve to. Mocked rather than driven by a temp git repo
 * because `getProjectRoot` shells out through zx, whose `$` does not follow `process.chdir` —
 * a chdir'd fixture would silently audit THIS repo instead. Every other git-utils export
 * stays real.
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

const makeTmpPackage = (config: string, packageJson: Record<string, unknown>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cmd-'))

  tmpDirs.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson))
  fs.writeFileSync(path.join(dir, 'infra-kit.config.ts'), config)

  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()

    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('audit', () => {
  it('passes a package that satisfies its resolved rules', async () => {
    const dir = makeTmpPackage('export default { requiredScripts: [], requiredFiles: [] }', {
      name: '@x/ok',
      type: 'module',
    })

    const result = await audit({ cwd: dir })

    expect(result.structuredContent.allPassed).toBe(true)
    expect(result.structuredContent.packages[0]?.name).toBe('@x/ok')
  })

  it('fails a package missing infra-kit.config.ts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cmd-'))

    tmpDirs.push(dir)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@x/no-config', type: 'module' }))

    const result = await audit({ cwd: dir })

    expect(result.structuredContent.allPassed).toBe(false)
  })

  it('collapses a passing audit to a single summary line', async () => {
    const dir = makeTmpPackage('export default { requiredScripts: [], requiredFiles: [] }', {
      name: '@x/quiet',
      type: 'module',
    })

    const lines = await captureLog(() => {
      return audit({ cwd: dir })
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^✅ audit passed — \d+ check(s?), 1 target$/u)
  })

  it('prints only the failing checks, plus the summary', async () => {
    const dir = makeTmpPackage('export default { requiredScripts: ["build"], requiredFiles: [] }', {
      name: '@x/loud',
      type: 'module',
    })

    const lines = await captureLog(() => {
      return audit({ cwd: dir })
    })

    expect(
      lines.filter((line) => {
        return line.startsWith('[FAIL] ')
      }),
    ).toEqual(['[FAIL] @x/loud script:build: missing "build" in package.json scripts'])
    // Three checks now: infra-kit.config.ts, agent-guidance, script:build.
    expect(lines.at(-1)).toBe('❌ audit failed — 1/3 checks, 1 target')
    expect(lines).toHaveLength(2)
  })
})

describe('mCP tool registration', () => {
  it('exposes the canonical `audit` tool', () => {
    expect(auditMcpTool.name).toBe('audit')
  })
})

/** A well-formed package block — what the adoption probe accepts as evidence. */
const PACKAGE_BLOCK = [
  '<!-- infra-kit:package:begin -->',
  '<!-- infra-kit:package:version 0.4.0 lib -->',
  '# @ws/pkg',
  '<!-- infra-kit:package:end -->',
].join('\n')

/** The ROOT block. Legitimate in the repo root's CLAUDE.md, a `foreign-block` inside a package. */
const ROOT_BLOCK = ['<!-- infra-kit:begin -->', 'root guidance', '<!-- infra-kit:end -->'].join('\n')

/* eslint-disable sonarjs/no-os-command-from-path -- hermetic test fixture drives the real `git` CLI */
/**
 * Make `dir` a git repo. `audit --root` reaches the project config loader, which shells out to
 * git inside the resolved project root, so a non-repo fixture root fails there rather than in
 * anything this suite is testing.
 */
const gitInit = (dir: string): void => {
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' })
}
/* eslint-enable sonarjs/no-os-command-from-path */

/**
 * A pnpm workspace with `packages/a` and `packages/b`. Realpath'd so the paths the adoption
 * probe reports match the ones the fixture wrote (macOS maps /var → /private/var).
 */
const makeWorkspace = (): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ws-')))

  tmpDirs.push(root)
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ws-root', type: 'module' }))
  // Marks the repo as an infra-kit project: `audit --root` loads it via the preset-proxy check.
  // `envManagement` is the one required key; no `devServersPresets`, so that check returns null.
  fs.writeFileSync(
    path.join(root, 'infra-kit.json'),
    JSON.stringify({ envManagement: { provider: 'doppler', config: { name: 'ws-root' } } }),
  )
  fs.writeFileSync(
    path.join(root, 'infra-kit.config.ts'),
    'export default { requiredScripts: [], requiredFiles: [], turbo: { requiredTasks: [] } }',
  )

  for (const name of ['a', 'b']) {
    const dir = path.join(root, 'packages', name)

    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@ws/${name}`, type: 'module' }))
    fs.writeFileSync(path.join(dir, 'infra-kit.config.ts'), 'export default { requiredScripts: [], requiredFiles: [] }')
  }

  gitInit(root)

  return root
}

type AuditResult = Awaited<ReturnType<typeof audit>>

/** Every `agent-guidance` check in an audit result, tagged with the package that produced it. */
const guidanceChecks = (result: AuditResult): { package: string; status: string; message: string }[] => {
  return result.structuredContent.packages.flatMap((pkg) => {
    return pkg.checks
      .filter((check) => {
        return check.name === 'agent-guidance'
      })
      .map((check) => {
        return { package: pkg.name, status: check.status, message: check.message }
      })
  })
}

/** The single `agent-guidance` check for one package name, or undefined when none was emitted. */
const guidanceFor = (result: AuditResult, packageName: string) => {
  return guidanceChecks(result).find((check) => {
    return check.package === packageName
  })
}

describe('audit — agent-guidance before adoption', () => {
  beforeEach(() => {
    resetAdoptionCache()
  })

  it('passes every package and names each state when no package carries a block', async () => {
    const root = makeWorkspace()

    // `a` has no CLAUDE.md at all; `b` has one carrying no infra-kit markers. Neither is evidence.
    fs.writeFileSync(path.join(root, 'packages/b/CLAUDE.md'), '# hand-written guidance\n')
    projectRoot.value = root

    const result = await audit({ all: true })

    expect(result.structuredContent.allPassed).toBe(true)
    expect(guidanceFor(result, '@ws/a')).toEqual({
      package: '@ws/a',
      status: 'pass',
      message: 'not yet adopted — CLAUDE.md missing — run: infra-kit audit --fix',
    })
    expect(guidanceFor(result, '@ws/b')?.status).toBe('pass')
    expect(guidanceFor(result, '@ws/b')?.message).toContain('not yet adopted — CLAUDE.md has no infra-kit block')
  })
})

describe('audit — agent-guidance after adoption', () => {
  beforeEach(() => {
    resetAdoptionCache()
  })

  it('fails only the package without a CLAUDE.md, naming the adopting package', async () => {
    const root = makeWorkspace()

    fs.writeFileSync(path.join(root, 'packages/a/CLAUDE.md'), PACKAGE_BLOCK)
    projectRoot.value = root

    const result = await audit({ all: true })

    expect(result.structuredContent.allPassed).toBe(false)
    expect(guidanceFor(result, '@ws/a')).toEqual({
      package: '@ws/a',
      status: 'pass',
      message: 'present (block from infra-kit 0.4.0, type lib)',
    })

    const failing = guidanceFor(result, '@ws/b')

    expect(failing?.status).toBe('fail')
    expect(failing?.message).toContain('CLAUDE.md missing')
    expect(failing?.message).toContain('infra-kit audit --fix')
    expect(failing?.message).toContain('packages/a/CLAUDE.md')
  })

  it('fails a package that carries the ROOT block instead of a package block', async () => {
    const root = makeWorkspace()

    fs.writeFileSync(path.join(root, 'packages/a/CLAUDE.md'), PACKAGE_BLOCK)
    fs.writeFileSync(path.join(root, 'packages/b/CLAUDE.md'), ROOT_BLOCK)
    projectRoot.value = root

    const result = await audit({ all: true })

    const failing = guidanceFor(result, '@ws/b')

    expect(failing?.status).toBe('fail')
    expect(failing?.message).toBe(
      'CLAUDE.md carries the ROOT infra-kit block (<!-- infra-kit:begin -->); a package needs the package block — run: infra-kit audit --fix',
    )
  })

  it('still reports agent-guidance when infra-kit.config.ts fails to load', async () => {
    const root = makeWorkspace()

    fs.writeFileSync(path.join(root, 'packages/a/CLAUDE.md'), PACKAGE_BLOCK)
    fs.writeFileSync(path.join(root, 'packages/b/infra-kit.config.ts'), 'export default { requiredScript: [] }')
    projectRoot.value = root

    const result = await audit({ all: true })

    const broken = result.structuredContent.packages.find((pkg) => {
      return pkg.name === '@ws/b'
    })

    expect(
      broken?.checks.map((check) => {
        return check.name
      }),
    ).toEqual(['infra-kit.config.ts', 'agent-guidance'])
  })
})

describe('audit --root — agent-guidance regression', () => {
  beforeEach(() => {
    resetAdoptionCache()
  })

  it('emits no agent-guidance check for the root, even in an adopted workspace', async () => {
    const root = makeWorkspace()

    fs.writeFileSync(path.join(root, 'packages/a/CLAUDE.md'), PACKAGE_BLOCK)
    // The root legitimately carries the ROOT pair; the package-scoped check would call it foreign.
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), ROOT_BLOCK)
    projectRoot.value = root

    const result = await audit({ root: true })

    expect(
      result.structuredContent.packages.flatMap((pkg) => {
        return pkg.checks.map((check) => {
          return check.name
        })
      }),
    ).not.toContain('agent-guidance')
    expect(result.structuredContent.allPassed).toBe(true)
  })
})

describe('audit — per-package shape (no flags)', () => {
  beforeEach(() => {
    resetAdoptionCache()
  })

  it('walks up to the workspace root to resolve adoption, in both states', async () => {
    const root = makeWorkspace()
    const packageB = path.join(root, 'packages/b')

    const before = await audit({ cwd: packageB })

    expect(before.structuredContent.allPassed).toBe(true)
    expect(guidanceFor(before, '@ws/b')?.message).toBe(
      'not yet adopted — CLAUDE.md missing — run: infra-kit audit --fix',
    )

    fs.writeFileSync(path.join(root, 'packages/a/CLAUDE.md'), PACKAGE_BLOCK)
    resetAdoptionCache()

    const after = await audit({ cwd: packageB })

    expect(after.structuredContent.allPassed).toBe(false)
    expect(guidanceFor(after, '@ws/b')?.message).toContain('packages/a/CLAUDE.md')
  })
})

describe('audit — the MCP surface cannot mutate the repo', () => {
  beforeEach(() => {
    resetAdoptionCache()
  })

  /**
   * The barrier is the input schema, not a runtime guard: `fix` is simply not expressible in an
   * MCP call. The MCP boundary auto-confirms every tool invocation, so a writing flag one key
   * away from an agent is a writing flag an agent will eventually use.
   */
  it('accepts only the two scope flags, so `fix` and `design` are not expressible', () => {
    expect(Object.keys(auditMcpTool.inputSchema).sort()).toEqual(['all', 'root'])
  })

  it('creates no CLAUDE.md when invoked through the MCP handler', async () => {
    const root = makeWorkspace()

    projectRoot.value = root

    await auditMcpTool.handler({ all: true, confirmedCommand: false })

    for (const name of ['a', 'b']) {
      expect(fs.existsSync(path.join(root, 'packages', name, 'CLAUDE.md')), `packages/${name}`).toBe(false)
    }
  })

  it('returns no `fixed` field, so the documented output schema stays accurate', async () => {
    const root = makeWorkspace()

    projectRoot.value = root

    const result = await auditMcpTool.handler({ all: true, confirmedCommand: false })

    expect('fixed' in (result.structuredContent ?? {})).toBe(false)
  })
})
