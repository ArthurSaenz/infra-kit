import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import yaml from 'yaml'
import { z } from 'zod'

import {
  getInfraKitConfigPaths,
  infraKitConfigSchema,
  infraKitOverrideConfigSchema,
  resetInfraKitConfigCache,
} from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'

interface MigrateLayer {
  label: string
  /** Legacy YAML source path. */
  yml: string
  /** Target JSON path. */
  json: string
  /** Validates the parsed object before any write (main vs override schema). */
  schema: z.ZodType
}

/**
 * Replace the user's home prefix with `~` so logged paths stay short.
 *
 * @example
 * // os.homedir() === '/Users/arthur'
 * tildify('/Users/arthur/.infra-kit/config.yml') // => '~/.infra-kit/config.yml'
 */
const tildify = (filePath: string): string => {
  const home = os.homedir()

  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath
}

/**
 * `fs.access` reduced to a boolean, swallowing ENOENT.
 *
 * @example
 * await fileExists('/etc/hosts') // => true
 */
const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath)

    return true
  } catch {
    return false
  }
}

/**
 * Swap a resolved `.json` config path back to its legacy `.yml` sibling.
 *
 * @example
 * legacyYmlPath('/repo/infra-kit.json') // => '/repo/infra-kit.yml'
 */
const legacyYmlPath = (jsonPath: string): string => {
  return jsonPath.replace(/\.json$/, '.yml')
}

/**
 * Convert any legacy `infra-kit.yml` config layers to `infra-kit.json` as part
 * of `infra-kit init`. Best-effort and non-fatal: each merge-chain layer
 * (project, user-global, user-project) is migrated independently, and a
 * conflict (both `.yml` and `.json` present) or an invalid `.yml` warns and
 * skips that layer rather than aborting init or touching the other layers.
 * Idempotent — already-JSON layers are left untouched.
 *
 * @example
 * await migrateLegacyConfig()
 * // INFO: ✓ Migrated infra-kit.yml → infra-kit.json
 * // (no output when there is nothing legacy to convert)
 */
export const migrateLegacyConfig = async (): Promise<void> => {
  let paths: Awaited<ReturnType<typeof getInfraKitConfigPaths>>

  try {
    paths = await getInfraKitConfigPaths()
  } catch {
    // No resolvable project (e.g. init run outside a repo) — nothing to migrate.
    return
  }

  const layers: MigrateLayer[] = [
    { label: 'infra-kit.json', yml: legacyYmlPath(paths.main), json: paths.main, schema: infraKitConfigSchema },
    {
      label: '~/.infra-kit/config.json',
      yml: legacyYmlPath(paths.userGlobal),
      json: paths.userGlobal,
      schema: infraKitOverrideConfigSchema,
    },
    {
      label: `~/.infra-kit/projects/${paths.projectName}/infra-kit.json`,
      yml: legacyYmlPath(paths.userProject),
      json: paths.userProject,
      schema: infraKitOverrideConfigSchema,
    },
  ]

  let migrated = 0

  for (const layer of layers) {
    const [ymlExists, jsonExists] = await Promise.all([fileExists(layer.yml), fileExists(layer.json)])

    if (!ymlExists) continue

    if (jsonExists) {
      logger.info(
        `⚠ Skipped ${tildify(layer.yml)} — ${tildify(layer.json)} already exists (remove the stale .yml manually)`,
      )

      continue
    }

    // Keep per-layer migration non-fatal even for malformed YAML or I/O errors
    // (TOCTOU after the existence probe, EACCES, read-only FS): warn and skip
    // so one bad layer never aborts `init` or the other layers.
    try {
      const raw = await fs.readFile(layer.yml, 'utf-8')
      const parsed = (yaml.parse(raw) ?? {}) as unknown
      const result = layer.schema.safeParse(parsed)

      if (!result.success) {
        logger.info(`⚠ Skipped ${tildify(layer.yml)} — invalid config: ${z.prettifyError(result.error)}`)

        continue
      }

      await fs.mkdir(path.dirname(layer.json), { recursive: true })
      await fs.writeFile(layer.json, `${JSON.stringify(result.data, null, 2)}\n`, 'utf-8')
      await fs.rm(layer.yml, { force: true })

      logger.info(`✓ Migrated ${tildify(layer.yml)} → ${tildify(layer.json)}`)
      migrated++
    } catch (err) {
      logger.info(`⚠ Skipped ${tildify(layer.yml)} — ${(err as Error).message}`)
    }
  }

  if (migrated > 0) {
    resetInfraKitConfigCache()
  }
}
