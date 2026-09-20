import type { ConfigMigration } from '../types'
import { omitKey } from './omit-key'

const RETIRED_IDE_PROVIDER = 'zed'

const isRetiredIdeEntry = (entry: unknown): boolean => {
  return (
    entry !== null && typeof entry === 'object' && (entry as { provider?: unknown }).provider === RETIRED_IDE_PROVIDER
  )
}

// An array that held only Zed loses the `ide` key outright: `ide: []` fails the schema's `.min(1)`,
// and it means "no editor" anyway.
const stripRetiredZedIde: ConfigMigration['apply'] = (parsed) => {
  const ide = parsed.ide

  if (Array.isArray(ide)) {
    const kept = ide.filter((entry) => {
      return !isRetiredIdeEntry(entry)
    })

    if (kept.length === ide.length) return { changed: false, result: parsed }

    return { changed: true, result: kept.length > 0 ? { ...parsed, ide: kept } : omitKey(parsed, 'ide') }
  }

  if (isRetiredIdeEntry(ide)) return { changed: true, result: omitKey(parsed, 'ide') }

  return { changed: false, result: parsed }
}

export const stripRetiredZedIdeMigration: ConfigMigration = {
  id: 'strip-retired-zed-ide',
  note: 'the retired "zed" provider',
  apply: stripRetiredZedIde,
}
