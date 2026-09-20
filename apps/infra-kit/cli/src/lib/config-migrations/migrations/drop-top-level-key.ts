import type { ConfigMigration } from '../types'
import { omitKey } from './omit-key'

/**
 * A migration that removes one top-level key, whatever its value: the strict schema refuses the key
 * regardless, so inspecting the value would only add a way for the migration to disagree with it.
 */
export const dropTopLevelKey = ({ key, id, note }: { key: string; id: string; note: string }): ConfigMigration => {
  return {
    id,
    note,
    apply: (parsed) => {
      if (!(key in parsed)) return { changed: false, result: parsed }

      return { changed: true, result: omitKey(parsed, key) }
    },
  }
}
