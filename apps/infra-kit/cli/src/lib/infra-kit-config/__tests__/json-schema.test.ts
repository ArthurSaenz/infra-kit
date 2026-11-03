import fs from 'node:fs'
import path from 'node:path'
import { format, resolveConfig } from 'prettier'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { SUPPORTED_CONFIG_VERSION, configSchemaUrl, infraKitConfigObject } from '../infra-kit-config'

/**
 * `schema/infra-kit.schema.json` is generated from `infraKitConfigObject` and committed; the build
 * copies it into `dist/`, where a stamped `$schema` finds it on unpkg. This file is its generator:
 * `pnpm run generate-config-schema` re-runs it with `--update`, and a plain run fails while the committed
 * file lags the zod schema.
 */
const SCHEMA_FILE = path.resolve(__dirname, '../../../../schema/infra-kit.schema.json')

const generate = async (): Promise<string> => {
  const schema = z.toJSONSchema(infraKitConfigObject, { io: 'input', unrepresentable: 'any' })
  const json = JSON.stringify({ ...schema, title: 'infra-kit.json' }, null, 2)

  return format(json, { ...(await resolveConfig(SCHEMA_FILE)), parser: 'json' })
}

const REPO_CONFIG = path.resolve(__dirname, '../../../../../../../infra-kit.json')

/**
 * Configs the loader accepts, this repo's own file included. The JSON Schema must accept each: an
 * editor that underlines a file the CLI reads is worse than no schema.
 */
const LOADER_ACCEPTS: Record<string, unknown>[] = [
  JSON.parse(fs.readFileSync(REPO_CONFIG, 'utf8')) as Record<string, unknown>,
  { envManagement: { provider: 'doppler', config: { name: 'api' } } },
  {
    $schema: configSchemaUrl('0.42.0'),
    configVersion: SUPPORTED_CONFIG_VERSION,
    envManagement: { provider: 'doppler', config: { name: 'api' } },
    defaultEnv: 'dev',
    gitFlow: 'main',
    protectedEnvs: 'cli-only',
    aliasRepo: 'api',
    audit: { requiredScripts: ['qa'], requiredFiles: ['turbo.json'], turbo: { requiredTasks: ['build'] } },
    vendorSource: null,
  },
]

describe('infra-kit.json JSON Schema', () => {
  it('is the committed file, regenerated from the zod schema', async () => {
    await expect(await generate()).toMatchFileSnapshot(SCHEMA_FILE)
  })

  it.each(
    LOADER_ACCEPTS.map((config, index) => {
      return [index, config] as const
    }),
  )('is no stricter than the loader (config %i)', async (_index, config) => {
    expect(infraKitConfigObject.safeParse(config).success, 'fixture must be one the loader reads').toBe(true)

    const fromJsonSchema = z.fromJSONSchema(JSON.parse(await generate()))

    expect(fromJsonSchema.safeParse(config).error).toBeUndefined()
  })

  it('names every key the loader reads, and requires no more than the loader does', async () => {
    const schema = JSON.parse(await generate()) as { properties: Record<string, unknown>; required?: string[] }

    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(infraKitConfigObject.shape).sort())
    expect(schema.required ?? []).toEqual(['envManagement'])
  })
})
