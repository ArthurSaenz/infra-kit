import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import { DEFAULT_RULES, ROOT_DEFAULT_RULES } from 'src/lib/package-config'

import { checkEmptyRules, findEmptyRules } from '../empty-rules-check'

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

const tmpDirs: string[] = []

const packageWithConfig = (config: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-empty-rules-'))

  tmpDirs.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@x/p', type: 'module' }))
  fs.writeFileSync(path.join(dir, 'infra-kit.config.ts'), config)

  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })

  vi.clearAllMocks()
})

describe('findEmptyRules', () => {
  it('warns once per explicitly empty key and names the defaults it switched off', () => {
    const checks = findEmptyRules({ requiredScripts: [], requiredFiles: [] }, DEFAULT_RULES, 'infra-kit.config.ts')

    expect(
      checks.map((check) => {
        return check.status
      }),
    ).toEqual(['warn', 'warn'])
    expect(checks[0]!.message).toContain('requiredScripts: []')
    expect(checks[0]!.message).toContain(DEFAULT_RULES.requiredScripts.join(', '))
    expect(checks[1]!.message).toContain('requiredFiles: []')
    expect(checks[1]!.message).toContain('delete the key to inherit the defaults')
  })

  it('ignores absent keys and non-empty overrides', () => {
    expect(findEmptyRules({}, DEFAULT_RULES, 'infra-kit.config.ts')).toEqual([])
    expect(findEmptyRules({ requiredScripts: ['build'] }, DEFAULT_RULES, 'infra-kit.config.ts')).toEqual([])
  })
})

describe('checkEmptyRules', () => {
  it('reads the authored package config, not the merged rules', async () => {
    const dir = packageWithConfig('export default { requiredFiles: [] }')

    const checks = await checkEmptyRules(dir, false)

    expect(checks).toHaveLength(1)
    expect(checks[0]!.message).toMatch(/^infra-kit\.config\.ts sets requiredFiles: \[\]/u)
  })

  it('reads the root rules from infra-kit.json "audit"', async () => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({ audit: { requiredScripts: [] } } as never)

    const checks = await checkEmptyRules('/repo', true)

    expect(checks).toHaveLength(1)
    expect(checks[0]!.message).toContain('infra-kit.json "audit" sets requiredScripts: []')
    expect(checks[0]!.message).toContain(ROOT_DEFAULT_RULES.requiredScripts.join(', '))
  })

  it('reports nothing for a config that fails to load — the config row already fails', async () => {
    const dir = packageWithConfig('export default { requiredScript: [] }')

    expect(await checkEmptyRules(dir, false)).toEqual([])
  })
})
