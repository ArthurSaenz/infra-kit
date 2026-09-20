import { CONFIG_MIGRATIONS } from './registry'
import type { MigrationResult } from './types'

/**
 * Fold the registry over a parsed config. Pure: the input is never mutated, and when no step
 * changes anything the returned `result` IS the input reference, so a caller can `===` it to skip
 * a rewrite. Idempotent by construction — every step is delete-only, so a second pass finds
 * nothing to delete.
 */
export const applyConfigMigrations = (parsed: Record<string, unknown>): MigrationResult => {
  return CONFIG_MIGRATIONS.reduce<MigrationResult>(
    (acc, migration) => {
      const step = migration.apply(acc.result)

      if (!step.changed) return acc

      return { changed: true, result: step.result, notes: [...acc.notes, migration.note] }
    },
    { changed: false, result: parsed, notes: [] },
  )
}
