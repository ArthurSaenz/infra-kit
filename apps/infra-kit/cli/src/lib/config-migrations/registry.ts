import { dropDevProxyKeyMigration } from './migrations/drop-dev-proxy-key'
import { dropEnvironmentsKeyMigration } from './migrations/drop-environments-key'
import { stripLegacyIdeModeMigration } from './migrations/strip-legacy-ide-mode'
import { stripRetiredZedIdeMigration } from './migrations/strip-retired-zed-ide'
import type { ConfigMigration } from './types'

/**
 * Applied in this order — the order the "removed …" notes are printed in. Each step deletes a
 * disjoint shape, so the order is not load-bearing for the result; it is fixed so the note line is
 * stable across runs.
 */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [
  stripLegacyIdeModeMigration,
  stripRetiredZedIdeMigration,
  dropEnvironmentsKeyMigration,
  dropDevProxyKeyMigration,
]
