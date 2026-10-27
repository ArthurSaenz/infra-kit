import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildRootBody, resetAdoptionCache, syncPackageGuidance } from 'src/lib/agent-guidance'
import { ROOT_MARKER_END, ROOT_MARKER_START, ROOT_VERSION_PREFIX } from 'src/lib/agent-guidance/markers'
import { buildManagedBlock } from 'src/lib/managed-block'
import { buildProgram } from 'src/lib/program'

import packageJson from '../../../../package.json' with { type: 'json' }
import { audit } from '../audit'
import { checkPackageGuidanceDrift, checkRootGuidanceDrift, compareGuidance } from '../guidance-check'
import { captureLog } from './helpers/capture-log'

const projectRoot = vi.hoisted(() => {
  return { value: '' }
})

/** Flips the shipped `package/lib` resource text, standing in for a guidance edit in `cli/resources`. */
const resourceEdited = vi.hoisted(() => {
  return { value: false }
})

vi.mock('src/lib/git-utils', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('src/lib/git-utils')>()),
    getProjectRoot: async () => {
      return projectRoot.value
    },
  }
})

vi.mock('src/lib/agent-guidance/resources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/agent-guidance/resources')>()

  return {
    ...actual,
    RESOURCES: new Proxy(actual.RESOURCES, {
      get: (target, key: keyof typeof actual.RESOURCES) => {
        return key === 'package/lib' && resourceEdited.value
          ? `${target[key]}\n- A rule added in a later release.`
          : target[key]
      },
    }),
  }
})

// The preAction hook seeds `$HOME`; not under test.
vi.mock('src/lib/config-bootstrap', () => {
  return { ensureUserProjectConfig: vi.fn(async () => {}) }
})

const CURRENT = '0.34.0'

const rootFile = (body: string): string => {
  return `# repo\n\n${buildManagedBlock(ROOT_MARKER_START, body, ROOT_MARKER_END)}\n`
}

const compareRoot = (content: string) => {
  return compareGuidance({
    content,
    expectedBody: buildRootBody(CURRENT),
    startMarker: ROOT_MARKER_START,
    endMarker: ROOT_MARKER_END,
    versionPrefix: ROOT_VERSION_PREFIX,
    current: CURRENT,
    scope: 'root',
  })
}

/** `buildRootBody(version)` with one line of its text changed, so the content differs too. */
const editedRootBody = (version: string): string => {
  return `${buildRootBody(version)}\nhand edit`
}

describe('compareGuidance — version-directional matrix', () => {
  it('passes identical content', () => {
    expect(compareRoot(rootFile(buildRootBody(CURRENT))).status).toBe('pass')
  })

  it('passes when only the version line differs, in either direction', () => {
    expect(compareRoot(rootFile(buildRootBody('0.1.0'))).status).toBe('pass')
    expect(compareRoot(rootFile(buildRootBody('9.0.0'))).status).toBe('pass')
  })

  it('warns with the --fix remediation when an older block differs', () => {
    expect(compareRoot(rootFile(editedRootBody('0.1.0')))).toEqual({
      name: 'agent-guidance:drift',
      status: 'warn',
      message: `block from infra-kit 0.1.0 differs from what infra-kit ${CURRENT} generates — run \`ik audit --fix --root\``,
    })
  })

  it('warns that the CLI is behind when a newer block differs, and never suggests --fix', () => {
    const check = compareRoot(rootFile(editedRootBody('9.0.0')))

    expect(check.status).toBe('warn')
    expect(check.message).toContain('CLI behind the block, run `pnpm add -g infra-kit@9.0.0`')
    expect(check.message).not.toContain('--fix')
  })

  it('warns when a same-version block differs (edited inside the markers)', () => {
    const check = compareRoot(rootFile(editedRootBody(CURRENT)))

    expect(check.status).toBe('warn')
    expect(check.message).toContain('edited inside the markers')
    expect(check.message).toContain('ik audit --fix --root')
  })
})

const tmpDirs: string[] = []

const makeWorkspace = (): { root: string; pkg: string } => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-guidance-')))
  const pkg = path.join(root, 'packages', 'a')

  tmpDirs.push(root)
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ws-root', type: 'module' }))
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: '@ws/a', type: 'module', scripts: { build: 'tsc' } }),
  )
  fs.writeFileSync(
    path.join(pkg, 'infra-kit.config.ts'),
    "export default { type: 'lib', requiredScripts: ['build'], requiredFiles: ['package.json'] }",
  )

  return { root, pkg }
}

beforeEach(() => {
  resourceEdited.value = false
  resetAdoptionCache()
  process.exitCode = undefined
})

afterEach(() => {
  process.exitCode = undefined

  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('checkRootGuidanceDrift / checkPackageGuidanceDrift', () => {
  it('produces no row without a block — presence is another check', async () => {
    const { root, pkg } = makeWorkspace()

    expect(checkRootGuidanceDrift(root, CURRENT)).toBeNull()
    expect(await checkPackageGuidanceDrift(pkg, root, 'all', CURRENT)).toBeNull()
  })

  it('passes a package block --fix just wrote at an older version', async () => {
    const { root, pkg } = makeWorkspace()

    await syncPackageGuidance(pkg, { repoRoot: root, version: '0.1.0' })

    expect((await checkPackageGuidanceDrift(pkg, root, 'all', CURRENT))?.status).toBe('pass')
  })
})

/**
 * The fleet-red scenario the warn exists for: a release edits guidance text in `cli/resources`,
 * and every consumer still carries the block the previous release wrote. Their qa must stay green.
 */
describe('guidance-text edit with an untouched consumer block', () => {
  const writeOldConsumerBlock = async (): Promise<string> => {
    const { root, pkg } = makeWorkspace()

    await syncPackageGuidance(pkg, { repoRoot: root, version: '0.1.0' })
    resourceEdited.value = true
    projectRoot.value = root

    return root
  }

  it('warns with the --all remediation and keeps the audit passing', async () => {
    await writeOldConsumerBlock()

    const lines = await captureLog(async () => {
      const result = await audit({ all: true })

      expect(result.structuredContent.allPassed).toBe(true)
      expect(result.structuredContent.warnCount).toBe(1)
    })

    expect(lines).toContain(
      `[WARN] @ws/a agent-guidance:drift: block from infra-kit 0.1.0 differs from what infra-kit ${packageJson.version} generates — run \`ik audit --fix --all\``,
    )
  })

  it('exits 0 through the CLI action', async () => {
    await writeOldConsumerBlock()

    await captureLog(async () => {
      await buildProgram().parseAsync(['node', 'infra-kit', 'audit', '--all'])
    })

    expect(process.exitCode).toBeUndefined()
  })
})
