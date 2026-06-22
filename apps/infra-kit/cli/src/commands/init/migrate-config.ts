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

/**
 * Surgically strip the removed `ide.config.mode` field from a parsed config
 * object (single-provider or array form). The windows-removal made `mode` a dead
 * key — the loader already ignores it, so this only matters for keeping the
 * on-disk file clean. Returns `changed: false` (and the input untouched) when
 * there is no `mode` to remove, so callers can skip rewriting clean files.
 *
 * Only `mode` is removed — every other key is preserved verbatim (no full-schema
 * re-validation), so a config that is otherwise invalid or carries forward-compat
 * keys is never altered beyond the dead field.
 */
const stripLegacyIdeMode = (parsed: Record<string, unknown>): { changed: boolean; result: Record<string, unknown> } => {
  const ide = parsed.ide

  if (ide === null || typeof ide !== 'object') {
    return { changed: false, result: parsed }
  }

  let changed = false

  const stripEntry = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object' || !('config' in entry)) {
      return entry
    }

    const config = (entry as { config: unknown }).config

    if (config === null || typeof config !== 'object' || !('mode' in config)) {
      return entry
    }

    changed = true

    const restConfig = Object.fromEntries(
      Object.entries(config as Record<string, unknown>).filter(([key]) => {
        return key !== 'mode'
      }),
    )

    return { ...(entry as Record<string, unknown>), config: restConfig }
  }

  const nextIde = Array.isArray(ide) ? ide.map(stripEntry) : stripEntry(ide)

  if (!changed) {
    return { changed: false, result: parsed }
  }

  return { changed: true, result: { ...parsed, ide: nextIde } }
}

/**
 * Normalize any existing `infra-kit.json` config layers (project, user-global,
 * user-project) from the old IDE structure to the new one by removing the
 * removed `ide.config.mode` field. Run by `infra-kit init` after the YAML→JSON
 * migration. Best-effort and non-fatal per layer; only rewrites a file when its
 * `ide` config actually carries the dead key, so clean configs are left byte-for-
 * byte untouched (idempotent). Resets the config cache when anything changed.
 *
 * @example
 * await normalizeLegacyIdeStructures()
 * // ✓ Normalized ide config in infra-kit.json (removed legacy "mode")
 * // (no output when no config carries a legacy "mode")
 */
export const normalizeLegacyIdeStructures = async (): Promise<void> => {
  let paths: Awaited<ReturnType<typeof getInfraKitConfigPaths>>

  try {
    paths = await getInfraKitConfigPaths()
  } catch {
    return
  }

  const jsonPaths = [paths.main, paths.userGlobal, paths.userProject]

  let normalized = 0

  for (const jsonPath of jsonPaths) {
    if (!(await fileExists(jsonPath))) continue

    try {
      const raw = await fs.readFile(jsonPath, 'utf-8')

      if (raw.trim() === '') continue

      const parsed = JSON.parse(raw) as Record<string, unknown>
      const { changed, result } = stripLegacyIdeMode(parsed)

      if (!changed) continue

      await fs.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8')

      logger.info(`✓ Normalized ide config in ${tildify(jsonPath)} (removed legacy "mode")`)
      normalized++
    } catch (err) {
      logger.info(`⚠ Skipped normalizing ${tildify(jsonPath)} — ${(err as Error).message}`)
    }
  }

  if (normalized > 0) {
    resetInfraKitConfigCache()
  }
}
