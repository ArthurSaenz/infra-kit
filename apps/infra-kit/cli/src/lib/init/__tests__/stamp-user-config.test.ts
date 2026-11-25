import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configSchemaUrl, infraKitOverrideConfigSchema } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

import { stampUserGlobalSchema } from '../stamp-user-config'

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

let home: string
let configPath: string

const write = (content: string): void => {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, content)
}

const read = (): string => {
  return fs.readFileSync(configPath, 'utf8')
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-user-config-test-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  configPath = path.join(home, '.infra-kit', 'infra-kit.json')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('stampUserGlobalSchema', () => {
  it('inserts $schema first and changes no other byte', async () => {
    write('{\n  "worktrees": { "openInOrca": true }\n}\n')

    await stampUserGlobalSchema('0.42.0')

    expect(read()).toBe(
      `{\n  "$schema": ${JSON.stringify(configSchemaUrl('0.42.0'))},\n  "worktrees": { "openInOrca": true }\n}\n`,
    )
  })

  it('stamps the empty stub `setup` seeds', async () => {
    write('{}\n')

    await stampUserGlobalSchema('0.42.0')

    expect(JSON.parse(read())).toEqual({ $schema: configSchemaUrl('0.42.0') })
  })

  // The loader refuses `configVersion` outside the committed project file, so a stamp that added it
  // would break every command on the machine.
  it('never adds configVersion, and the stamped file still parses as a user layer', async () => {
    write('{\n  "worktrees": { "openInOrca": true }\n}\n')

    await stampUserGlobalSchema('0.42.0')

    const stamped: unknown = JSON.parse(read())

    expect(stamped).not.toHaveProperty('configVersion')
    expect(infraKitOverrideConfigSchema.safeParse(stamped).success).toBe(true)
  })

  it('moves an older stamp of ours to this CLI', async () => {
    write(`{\n  "$schema": ${JSON.stringify(configSchemaUrl('0.41.0'))}\n}\n`)

    await stampUserGlobalSchema('0.42.0')

    expect(JSON.parse(read())).toEqual({ $schema: configSchemaUrl('0.42.0') })
  })

  it.each([
    ['already names this CLI', configSchemaUrl('0.42.0')],
    ['was stamped by a newer CLI', configSchemaUrl('0.43.0')],
    ['names a schema that is not ours', './my.schema.json'],
  ])('leaves the file byte-unchanged and logs nothing when it %s', async (_case, $schema) => {
    const original = `{\n  "$schema": ${JSON.stringify($schema)}\n}\n`

    write(original)

    await stampUserGlobalSchema('0.42.0')

    expect(read()).toBe(original)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('is a silent no-op when the file does not exist', async () => {
    await stampUserGlobalSchema('0.42.0')

    expect(fs.existsSync(configPath)).toBe(false)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('skips a malformed file with one line and leaves it alone', async () => {
    write('{ not json')

    await stampUserGlobalSchema('0.42.0')

    expect(read()).toBe('{ not json')
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^⚠ Skipped .+infra-kit\.json — /))
  })
})
