import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { audit, auditMcpTool } from '../audit'

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
})

describe('mCP tool registration', () => {
  it('exposes the canonical `audit` tool', () => {
    expect(auditMcpTool.name).toBe('audit')
  })
})
