import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SUPPORTED_CONFIG_VERSION, configSchemaUrl } from 'src/lib/infra-kit-config'

import { stampRootConfig } from '../migrate-root-config'

const tmpDirs: string[] = []

const repoWith = (config: unknown): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-root-'))

  tmpDirs.push(root)
  fs.writeFileSync(path.join(root, 'infra-kit.json'), `${JSON.stringify(config, null, 2)}\n`)

  return root
}

const read = (root: string): string => {
  return fs.readFileSync(path.join(root, 'infra-kit.json'), 'utf8')
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const ENV = { provider: 'doppler', config: { name: 'api' } }

describe('stampRootConfig', () => {
  it('puts $schema and configVersion first and keeps every other key in its order', async () => {
    const root = repoWith({ envManagement: ENV, gitFlow: 'main' })

    expect(await stampRootConfig(root, '0.42.0')).toEqual([
      { path: path.join(root, 'infra-kit.json'), action: 'updated' },
    ])
    expect(Object.entries(JSON.parse(read(root)))).toEqual([
      ['$schema', configSchemaUrl('0.42.0')],
      ['configVersion', SUPPORTED_CONFIG_VERSION],
      ['envManagement', ENV],
      ['gitFlow', 'main'],
    ])
  })

  // The fleet regression: a JSON.stringify rewrite re-wrapped every inline array, a diff prettier reverts.
  it('changes no byte of a prettier-formatted file beyond the two lines it inserts', async () => {
    const original = [
      '{',
      '  "envManagement": { "provider": "doppler", "config": { "name": "api" } },',
      '  "audit": { "requiredScripts": ["build", "test"], "requiredFiles": ["turbo.json"] },',
      '  "vendorTarget": { "modules": ["docs", "lint"] }',
      '}',
      '',
    ].join('\n')

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-root-pretty-'))

    tmpDirs.push(root)
    fs.writeFileSync(path.join(root, 'infra-kit.json'), original)

    await stampRootConfig(root, '0.42.0')

    const lines = read(root).split('\n')

    expect(lines.slice(1, 3)).toEqual([
      `  "$schema": "${configSchemaUrl('0.42.0')}",`,
      `  "configVersion": ${SUPPORTED_CONFIG_VERSION},`,
    ])
    expect([lines[0], ...lines.slice(3)].join('\n')).toBe(original)
  })

  it('re-stamps an older $schema in place, keeping a 4-space file and every other byte', async () => {
    const original = `{\n    "$schema": "${configSchemaUrl('0.40.0')}",\n    "configVersion": 1,\n    "gitFlow": "main",\n    "envManagement": { "provider": "doppler", "config": { "name": "api" } }\n}\n`
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-root-restamp-'))

    tmpDirs.push(root)
    fs.writeFileSync(path.join(root, 'infra-kit.json'), original)

    await stampRootConfig(root, '0.42.0')

    expect(read(root)).toBe(original.replace(configSchemaUrl('0.40.0'), configSchemaUrl('0.42.0')))
  })

  it('writes nothing on a second run', async () => {
    const root = repoWith({ envManagement: ENV })

    await stampRootConfig(root, '0.42.0')

    const before = read(root)

    expect(await stampRootConfig(root, '0.42.0')).toEqual([])
    expect(read(root)).toBe(before)
  })

  it('moves an older stamp up to this CLI', async () => {
    const root = repoWith({ $schema: configSchemaUrl('0.40.0'), configVersion: 1, envManagement: ENV })

    await stampRootConfig(root, '0.42.0')

    expect(JSON.parse(read(root)).$schema).toBe(configSchemaUrl('0.42.0'))
  })

  it('never moves a newer stamp back, nor replaces a $schema that is not ours', async () => {
    const newer = repoWith({ $schema: configSchemaUrl('0.50.0'), configVersion: 1, envManagement: ENV })
    const foreign = repoWith({ $schema: './my-schema.json', envManagement: ENV })

    await stampRootConfig(newer, '0.42.0')
    await stampRootConfig(foreign, '0.42.0')

    expect(JSON.parse(read(newer)).$schema).toBe(configSchemaUrl('0.50.0'))
    expect(JSON.parse(read(foreign))).toMatchObject({ $schema: './my-schema.json', configVersion: 1 })
  })

  it('refuses, untouched, a file whose configVersion this CLI cannot read', async () => {
    const root = repoWith({ configVersion: SUPPORTED_CONFIG_VERSION + 1, envManagement: ENV })
    const before = read(root)

    const [write] = await stampRootConfig(root, '0.42.0')

    expect(write?.action).toBe('failed')
    expect(read(root)).toBe(before)
  })

  it('does nothing outside an infra-kit project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-root-none-'))

    tmpDirs.push(root)

    expect(await stampRootConfig(root, '0.42.0')).toEqual([])
  })
})
