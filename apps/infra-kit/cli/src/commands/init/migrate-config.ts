import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'yaml'
import { z } from 'zod'

import {
  getInfraKitConfigPaths,
  infraKitConfigSchema,
  infraKitOverrideConfigSchema,
  resetInfraKitConfigCache,
} from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { fileExists, tildify } from 'src/lib/path-display'
import { getFactoryConfigPath } from 'src/lib/vendor/factory-config'
import { factoryConfigSchema } from 'src/lib/vendor/factory-config-schema'

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
      label: '~/.infra-kit/infra-kit.json',
      // The user-global JSON filename changed (config.json → infra-kit.json), but
      // the legacy YAML it converts from kept the old `config.yml` name. Pin it
      // here so it does not drift to `infra-kit.yml` via legacyYmlPath(); the
      // main/userProject layers keep deriving their `.yml` sibling normally
      // because their `.json` filename never changed.
      yml: path.join(path.dirname(paths.userGlobal), 'config.yml'),
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
 * Rename the user-global config from the legacy `config.json` filename to the
 * canonical `infra-kit.json` (and its `config.example.jsonc` reference to
 * `infra-kit.example.jsonc`), so every merge-chain layer shares one filename.
 * Run by `infra-kit init` before the user-global config is seeded, so a user's
 * existing overrides are carried forward instead of being shadowed by a fresh
 * `{}` stub written under the new name.
 *
 * Best-effort and non-fatal per file: a missing source is skipped silently
 * (idempotent — nothing to rename on a second run), and an already-present
 * target is never overwritten (the stale `config.json` is left in place so no
 * bytes are lost — the user reconciles it manually). Resets the config cache
 * when anything was renamed.
 *
 * @example
 * await migrateUserGlobalConfigFilename()
 * // ✓ Renamed ~/.infra-kit/config.json → ~/.infra-kit/infra-kit.json
 * // (no output when there is nothing legacy to rename)
 */
export const migrateUserGlobalConfigFilename = async (): Promise<void> => {
  let paths: Awaited<ReturnType<typeof getInfraKitConfigPaths>>

  try {
    paths = await getInfraKitConfigPaths()
  } catch {
    // No resolvable project (e.g. init run outside a repo) — nothing to rename.
    return
  }

  const dir = path.dirname(paths.userGlobal)
  // The config.json → infra-kit.json rename carries forward a user's REAL config and
  // is load-bearing. The example-file rename is now largely redundant: seedUserGlobalConfig
  // rewrites infra-kit.example.jsonc unconditionally moments later, so a renamed legacy
  // example is overwritten anyway (and if infra-kit.example.jsonc already exists, the
  // no-overwrite guard simply leaves an orphaned config.example.jsonc behind — harmless).
  const pairs: { from: string; to: string }[] = [
    { from: path.join(dir, 'config.json'), to: paths.userGlobal },
    { from: path.join(dir, 'config.example.jsonc'), to: path.join(dir, 'infra-kit.example.jsonc') },
  ]

  let renamed = 0

  for (const { from, to } of pairs) {
    const [fromExists, toExists] = await Promise.all([fileExists(from), fileExists(to)])

    if (!fromExists) continue

    if (toExists) {
      logger.info(`⚠ Skipped ${tildify(from)} — ${tildify(to)} already exists (remove the stale file manually)`)

      continue
    }

    // Same-directory rename is atomic; per-file try/catch keeps a TOCTOU race or
    // I/O error (EACCES, read-only FS) non-fatal so one bad file never aborts init.
    try {
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.rename(from, to)

      logger.info(`✓ Renamed ${tildify(from)} → ${tildify(to)}`)
      renamed++
    } catch (err) {
      logger.info(`⚠ Skipped ${tildify(from)} — ${(err as Error).message}`)
    }
  }

  if (renamed > 0) {
    resetInfraKitConfigCache()
  }
}

/**
 * Convert a legacy machine-local factory config from executable TypeScript
 * (`~/.infra-kit/vendor.config.ts`) to static JSON (`~/.infra-kit/vendor.json`) as
 * part of `infra-kit init`. The factory config used to be a `.ts` module loaded via
 * dynamic `import()`; it is now strict JSON read with `JSON.parse`. This one-shot
 * migration dynamic-imports the old `.ts` (the ONLY remaining dynamic import of the
 * factory file), resolves a factory-function or object default export, validates it,
 * writes `vendor.json`, and removes the old `.ts`.
 *
 * Best-effort, non-fatal, idempotent (no old `.ts` → no-op), and never overwrites an
 * existing `vendor.json`. When the old export was a FUNCTION, its resolved output is
 * frozen into static JSON — so a DISTINCT warning is emitted (not a plain
 * `✓ Migrated`) because dynamic re-evaluation (env vars, directory globbing) no
 * longer happens. No `resetInfraKitConfigCache()` — the factory loader shares no
 * cache with the `infra-kit.json` layers.
 *
 * @example
 * await migrateFactoryConfigToJson()
 * // ✓ Migrated ~/.infra-kit/vendor.config.ts → ~/.infra-kit/vendor.json
 * // (no output when there is nothing legacy to convert)
 */
export const migrateFactoryConfigToJson = async (): Promise<void> => {
  const newJson = getFactoryConfigPath() // ~/.infra-kit/vendor.json
  const dir = path.dirname(newJson)
  const oldTs = path.join(dir, 'vendor.config.ts')

  const [oldExists, newExists] = await Promise.all([fileExists(oldTs), fileExists(newJson)])

  if (!oldExists) return // idempotent: nothing to migrate (incl. after a prior successful run)

  if (newExists) {
    logger.info(
      `⚠ Skipped ${tildify(oldTs)} — ${tildify(newJson)} already exists (remove the stale vendor.config.ts manually)`,
    )

    return
  }

  // The factory `.ts` is executable; read it once via dynamic import (Node native
  // type stripping) with an mtime cache-bust, resolving a factory-function or object
  // default export. Per-file try/catch keeps a malformed module or I/O error
  // non-fatal so one bad file never aborts init.
  try {
    const stat = await fs.stat(oldTs)
    const moduleUrl = `${pathToFileURL(oldTs).href}?mtime=${Number(stat.mtimeMs)}`
    const imported = (await import(moduleUrl)) as { default?: unknown }
    const raw = imported.default
    const wasFunction = typeof raw === 'function'
    const resolved = wasFunction ? await (raw as () => unknown)() : raw

    const result = factoryConfigSchema.safeParse(resolved)

    if (!result.success) {
      logger.info(`⚠ Skipped ${tildify(oldTs)} — invalid factory config: ${z.prettifyError(result.error)}`)

      return // leave the old .ts in place so the user can fix and re-run; do not delete unconverted data
    }

    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(newJson, `${JSON.stringify(result.data, null, 2)}\n`, 'utf-8')
    await fs.rm(oldTs, { force: true })

    if (wasFunction) {
      // The old export was a function: its values were resolved ONCE and frozen into
      // static JSON. Disclose the lost dynamism instead of reporting a clean success.
      logger.info(
        `⚠ Migrated ${tildify(oldTs)} → ${tildify(newJson)} as a STATIC SNAPSHOT — the old file was a ` +
          `function (export default () => ({...})); computed values (env vars, directory globbing) were ` +
          `frozen at their current values and no longer re-evaluate. Edit ${tildify(newJson)} directly to change them.`,
      )
    } else {
      logger.info(`✓ Migrated ${tildify(oldTs)} → ${tildify(newJson)}`)
    }
  } catch (err) {
    logger.info(`⚠ Skipped ${tildify(oldTs)} — ${(err as Error).message}`)
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
