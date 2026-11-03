import type { ConfigMigration } from '../types'

interface RenameTopLevelKeyArgs {
  from: string
  to: string
  id: string
  note: string
  toVersion: number
}

/**
 * A migration that moves one top-level key to a new name, keeping its value and its position. A file
 * that already carries both keys is left alone: choosing a winner would drop a value someone wrote, and
 * the strict schema already refuses the retired key, which names the conflict for a human to settle.
 */
export const renameTopLevelKey = ({ from, to, id, note, toVersion }: RenameTopLevelKeyArgs): ConfigMigration => {
  return {
    kind: 'rename',
    toVersion,
    id,
    note,
    apply: (parsed) => {
      if (!(from in parsed) || to in parsed) return { changed: false, result: parsed }

      return {
        changed: true,
        result: Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => {
            return [key === from ? to : key, value]
          }),
        ),
      }
    },
  }
}
