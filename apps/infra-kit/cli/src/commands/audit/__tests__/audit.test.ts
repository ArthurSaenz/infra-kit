import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { logger } from 'src/lib/logger'

import { audit, auditMcpTool } from '../audit'

const tmpDirs: string[] = []

/** Capture every line `audit` writes through the logger for the duration of one run. */
const captureLog = async (run: () => Promise<unknown>): Promise<string[]> => {
  const lines: string[] = []
  const spy = vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
    lines.push(String(args[0]))
  })

  try {
    await run()
  } finally {
    spy.mockRestore()
  }

  return lines
}

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
    expect(lines.at(-1)).toBe('❌ audit failed — 1/2 checks, 1 target')
    expect(lines).toHaveLength(2)
  })
})

describe('mCP tool registration', () => {
  it('exposes the canonical `audit` tool', () => {
    expect(auditMcpTool.name).toBe('audit')
  })
})
