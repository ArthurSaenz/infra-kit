import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every assertion here runs in a child `node`, never in the vitest worker.
 *
 * Two reasons. Node only warns about a given `package.json` once per process, so an
 * in-process test would burn the one warning it needs to observe; and the suppressor
 * patches `process.emitWarning` for the lifetime of the process, which would leak into
 * sibling test files sharing the worker.
 */
const MODULE_URL = pathToFileURL(path.join(import.meta.dirname, '../node-warnings.ts')).href
const FIXTURE_URL = pathToFileURL(path.join(import.meta.dirname, 'fixtures/typeless-package/infra-kit.config.ts')).href

const runNode = (lines: string[]): { stderr: string; stdout: string; status: number | null } => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', lines.join('\n')], {
    encoding: 'utf8',
  })

  return { stderr: result.stderr, stdout: result.stdout, status: result.status }
}

const IMPORT_FIXTURE = [
  `const mod = await import(${JSON.stringify(FIXTURE_URL)})`,
  'console.log(JSON.stringify(mod.default))',
]

const INSTALL_SUPPRESSOR = [
  `import { suppressTypelessPackageJsonWarning } from ${JSON.stringify(MODULE_URL)}`,
  'suppressTypelessPackageJsonWarning()',
]

describe('suppressTypelessPackageJsonWarning', () => {
  it('the fixture really does provoke the warning without the suppressor', () => {
    // Negative control. If this ever stops warning, the fixture stopped reproducing the
    // bug and every other assertion in this file is a false green.
    const { stderr, stdout, status } = runNode(IMPORT_FIXTURE)

    expect(stderr).toContain('MODULE_TYPELESS_PACKAGE_JSON')
    expect(stdout.trim()).toBe('{"dev":{"port":3000}}')
    expect(status).toBe(0)
  })

  it('silences the warning while still importing the config', () => {
    const { stderr, stdout, status } = runNode([...INSTALL_SUPPRESSOR, ...IMPORT_FIXTURE])

    expect(stderr).not.toContain('MODULE_TYPELESS_PACKAGE_JSON')
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe('{"dev":{"port":3000}}')
    expect(status).toBe(0)
  })

  it('lets unrelated warnings through, in both emitWarning overloads', () => {
    const { stderr } = runNode([
      ...INSTALL_SUPPRESSOR,
      ...IMPORT_FIXTURE,
      `process.emitWarning('options overload', { code: 'KEEP_OPTIONS' })`,
      `process.emitWarning('legacy overload', 'Warning', 'KEEP_LEGACY')`,
    ])

    expect(stderr).not.toContain('MODULE_TYPELESS_PACKAGE_JSON')
    expect(stderr).toContain('KEEP_OPTIONS')
    expect(stderr).toContain('options overload')
    expect(stderr).toContain('KEEP_LEGACY')
    expect(stderr).toContain('legacy overload')
  })

  it('is idempotent — a second install does not double-wrap or drop warnings', () => {
    const { stderr, status } = runNode([
      ...INSTALL_SUPPRESSOR,
      'suppressTypelessPackageJsonWarning()',
      ...IMPORT_FIXTURE,
      `process.emitWarning('still here', { code: 'KEEP_ONCE' })`,
    ])

    expect(stderr).not.toContain('MODULE_TYPELESS_PACKAGE_JSON')
    expect(stderr.match(/KEEP_ONCE/g)).toHaveLength(1)
    expect(status).toBe(0)
  })
})
