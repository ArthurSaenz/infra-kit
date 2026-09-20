/**
 * One retired config shape and the delete-only transform that removes it.
 *
 * Delete-only contract: `apply` may remove a key at any depth or an entry from an array, but it
 * never renames, rewrites, or reorders sibling keys — a config that is otherwise invalid or carries
 * forward-compat keys is never altered beyond the retired shape. On `changed: false` it hands the
 * input reference back untouched, so callers can skip rewriting clean files. `apply` doubles as the
 * predicate: there is no separate `applies()` that could disagree with it.
 */
export interface ConfigMigration {
  id: string
  /** Goes into the "removed …" line the caller prints — say where the key went, so nobody re-adds it. */
  note: string
  apply: (parsed: Record<string, unknown>) => { changed: boolean; result: Record<string, unknown> }
}

export interface MigrationResult {
  changed: boolean
  result: Record<string, unknown>
  /** One `ConfigMigration.note` per step that changed something, in registry order. */
  notes: string[]
}
