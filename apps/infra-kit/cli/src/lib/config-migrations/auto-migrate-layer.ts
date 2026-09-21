import type { z } from 'zod'

import { isCI } from 'src/lib/agent-mode'
import { logger } from 'src/lib/logger'
import { tildify } from 'src/lib/path-display'

import packageJson from '../../../package.json' with { type: 'json' }
import { applyConfigMigrations } from './apply-config-migrations'
import { writeMigratedConfigFile } from './migrate-config-file'

/** The slice of the loader's `ConfigLayer` the retry needs; passed in so this module never imports the loader (cycle). */
export interface AutoMigrateLayer {
  path: string
  /** The tracked project layer — the only one a CI checkout must not rewrite. */
  required: boolean
  /** `'off'` for callers whose stderr nobody reads; they keep today's strict error instead of a rewritten file. */
  autoMigrate: 'write' | 'off'
  /** From the stat the loader already took before reading — the stale-read guard's baseline. */
  mtimeMs: number
}

export type AutoMigrateOutcome =
  /** `data` is the second `safeParse`'s output (defaults applied), never the raw migrated object. */
  | { kind: 'migrated'; data: Record<string, unknown> }
  /** A migration WOULD fix the required layer, but CI withholds the write — the caller appends its setup hint. */
  | { kind: 'ci-gated' }
  /** Policy off, nothing to migrate, still invalid afterwards, file moved, or the write failed: the caller throws its original error. */
  | { kind: 'not-applicable' }

/**
 * The loader's retry after the strict schema refused a layer: migrate in memory, prove the result
 * parses, write it back, and only then hand the parsed value over — a migrated value is never
 * returned without the file on disk matching it. Ordered so the CI gate fires only when a migration
 * would actually have fixed the file (a layer with a second, real problem gets the original error
 * naming every unrecognized key, with no misleading hint).
 *
 * `warn`, not `info`, for the one stderr line: `--json` lowers the logger to `warn` and the line
 * must still land — it is the only signal that a tracked file just gained a hunk to commit.
 */
export const tryAutoMigrateLayer = async (
  layer: AutoMigrateLayer,
  parsedRaw: Record<string, unknown>,
  raw: string,
  { schema }: { schema: z.ZodType },
): Promise<AutoMigrateOutcome> => {
  if (layer.autoMigrate === 'off') {
    return { kind: 'not-applicable' }
  }

  const migrated = applyConfigMigrations(parsedRaw)

  if (!migrated.changed) {
    return { kind: 'not-applicable' }
  }

  const second = schema.safeParse(migrated.result)

  if (!second.success) {
    return { kind: 'not-applicable' }
  }

  if (layer.required && isCI()) {
    return { kind: 'ci-gated' }
  }

  try {
    await writeMigratedConfigFile({
      path: layer.path,
      raw,
      migrated: migrated.result,
      expectedMtimeMs: layer.mtimeMs,
    })
  } catch (err) {
    logger.debug(err, `auto-migration could not rewrite ${layer.path}`)

    return { kind: 'not-applicable' }
  }

  logger.warn(
    `Migrated ${tildify(layer.path)}: removed ${migrated.notes.join(' and ')} (retired by infra-kit ${packageJson.version})`,
  )

  return { kind: 'migrated', data: second.data as Record<string, unknown> }
}
