import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'yaml'
import { z } from 'zod'

import { ConfigFileChangedError, migrateConfigFile } from 'src/lib/config-migrations'
import {
  getInfraKitConfigPaths,
  infraKitConfigSchema,
  infraKitOverrideConfigSchema,
  resetInfraKitConfigCache,
  resolveUserGlobalConfigPath,
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
 * of `infra-kit setup`. Best-effort and non-fatal: each merge-chain layer
 * (project, user-global, user-project) is migrated independently, and a
 * conflict (both `.yml` and `.json` present) or an invalid `.yml` warns and
 * skips that layer rather than aborting the run or touching the other layers.
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
    // so one bad layer never aborts `initCore` or the other layers.
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
 * Run by `infra-kit setup` before the user-global config is seeded, so a user's
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
 * (`~/.infra-kit/vendor.config.ts`) to static JSON (`~/.infra-kit/vendor.json`) as part of
 * `infra-kit setup`: dynamic-import the old `.ts`, resolve a factory-function or object default
 * export, validate it, write `vendor.json`, remove the old `.ts`.
 *
 * Best-effort, non-fatal, idempotent (no old `.ts` → no-op), and never overwrites an existing
 * `vendor.json`. A FUNCTION export emits a DISTINCT warning rather than a plain `✓ Migrated`.
 *
 * @example
 * await migrateFactoryConfigToJson()
 * // ✓ Migrated ~/.infra-kit/vendor.config.ts → ~/.infra-kit/vendor.json
 * // (no output when there is nothing legacy to convert)
 */
// The factory config used to be a `.ts` module loaded via dynamic `import()`; it is now strict
// JSON read with `JSON.parse`, and this one-shot migration holds the ONLY remaining dynamic
// import of the factory file.
//
// The function-export warning is not cosmetic: freezing a factory's resolved output into static
// JSON means dynamic re-evaluation (env vars, directory globbing) no longer happens, and the user
// has to be told. No `resetInfraKitConfigCache()` — the factory loader shares no cache with the
// `infra-kit.json` layers.
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
 * The explicit all-layers pass over the same registry the loader applies on read (see
 * {@link migrateConfigFile}), so a shape is retired in one place; the loader rewrites only the layer
 * it is reading, and only once the strict schema has refused it.
 *
 * The user-global layer is included even when `setup` runs OUTSIDE a project: it holds the
 * machine-wide `ide` choice, so it is the layer most likely to still carry a retired shape, and the
 * strict schema refuses it until it is rewritten — `setup` has to be the way out.
 *
 * Non-fatal per layer: a malformed file, an I/O error, or a file that changed between the read and
 * the write warns and skips, and the next run retries from fresh bytes. Ordered AFTER
 * `migrateUserGlobalConfigFilename` in `runConfigMigrations` because it addresses
 * `~/.infra-kit/infra-kit.json` by that fixed name.
 *
 * @example
 * await migrateConfigShapes()
 * // ✓ Migrated infra-kit.json (removed legacy "mode" and the retired "zed" provider)
 * // (no output when every layer is already clean)
 */
export const migrateConfigShapes = async (): Promise<void> => {
  const jsonPaths = await resolveMigrationTargets()

  let changed = 0

  for (const jsonPath of jsonPaths) {
    if (!(await fileExists(jsonPath))) continue

    try {
      const outcome = await migrateConfigFile(jsonPath)

      if (!outcome.changed) continue

      logger.info(`✓ Migrated ${tildify(jsonPath)} (removed ${outcome.notes.join(' and ')})`)
      changed++
    } catch (err) {
      // The stale-read error spells out the absolute path; the line already names the file.
      const reason = err instanceof ConfigFileChangedError ? 'changed while migrating' : (err as Error).message

      logger.info(`⚠ Skipped ${tildify(jsonPath)} — ${reason}`)
    }
  }

  if (changed > 0) {
    resetInfraKitConfigCache()
  }
}

/**
 * The layers {@link migrateConfigShapes} may rewrite: all three inside a project, only the
 * user-global file outside one (`getInfraKitConfigPaths` rejects there — it needs a git toplevel).
 */
const resolveMigrationTargets = async (): Promise<string[]> => {
  try {
    const paths = await getInfraKitConfigPaths()

    return [paths.main, paths.userGlobal, paths.userProject]
  } catch {
    return [resolveUserGlobalConfigPath()]
  }
}
