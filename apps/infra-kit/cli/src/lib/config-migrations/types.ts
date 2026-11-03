interface ConfigMigrationBase {
  id: string
  /** Goes into the "removed …" line the caller prints — say where the key went, so nobody re-adds it. */
  note: string
  apply: (parsed: Record<string, unknown>) => { changed: boolean; result: Record<string, unknown> }
}

/**
 * One retired config shape and the transform that retires it. `apply` doubles as the predicate: there
 * is no separate `applies()` that could disagree with it, and on `changed: false` it hands the input
 * reference back untouched, so callers can skip rewriting clean files. Every kind is idempotent: a
 * second pass finds its shape gone.
 *
 * - `drop` deletes the retired key at any depth (or an array entry) and nothing else — never renames,
 *   rewrites or reorders a sibling, so a config that is otherwise invalid is never altered beyond it.
 * - `rename` moves a value to a new key in place; `reshape` rewrites one key's structure. Both change
 *   what a file means rather than only pruning it, so each names the `configVersion` that introduced it
 *   (`toVersion`): the version `audit --fix --root` stamps, which a CLI older than it refuses to read.
 */
export type ConfigMigration =
  | (ConfigMigrationBase & { kind: 'drop'; toVersion?: never })
  | (ConfigMigrationBase & { kind: 'rename' | 'reshape'; toVersion: number })

export interface MigrationResult {
  changed: boolean
  result: Record<string, unknown>
  /** One `ConfigMigration.note` per step that changed something, in registry order. */
  notes: string[]
}
