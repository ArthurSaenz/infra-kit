import { dropDevKeyMigration } from './migrations/drop-dev-key'
import { dropDevPresetsKeyMigration } from './migrations/drop-dev-presets-key'
import { dropDevProxyKeyMigration } from './migrations/drop-dev-proxy-key'
import { dropEnvAutoLoadKeyMigration } from './migrations/drop-env-auto-load-key'
import { dropEnvironmentsKeyMigration } from './migrations/drop-environments-key'
import { dropIdeKeyMigration } from './migrations/drop-ide-key'
import { dropTaskManagerKeyMigration } from './migrations/drop-task-manager-key'
import type { ConfigMigration } from './types'

/**
 * Applied in this order — the order the "removed …" notes are printed in. Each step deletes a
 * disjoint shape, so the order is not load-bearing for the result; it is fixed so the note line is
 * stable across runs.
 */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [
  dropIdeKeyMigration,
  dropEnvironmentsKeyMigration,
  dropDevProxyKeyMigration,
  dropEnvAutoLoadKeyMigration,
  dropTaskManagerKeyMigration,
  dropDevPresetsKeyMigration,
  dropDevKeyMigration,
]

/**
 * The `configVersion` a file is at once every step has run: the highest `toVersion` of a `rename` or
 * `reshape`, else 1 (a `drop` only prunes, so it never moves the version).
 */
export const MIGRATED_CONFIG_VERSION = Math.max(
  1,
  ...CONFIG_MIGRATIONS.flatMap((migration) => {
    return migration.kind === 'drop' ? [] : [migration.toVersion]
  }),
)
