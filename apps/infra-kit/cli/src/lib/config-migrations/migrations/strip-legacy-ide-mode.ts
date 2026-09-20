import type { ConfigMigration } from '../types'
import { omitKey } from './omit-key'

// `ide.config.mode` chose the per-window attach style; the windows removal left one style, so the
// key is dead and the strict `ideConfigSchema` refuses it. Handles both the single-provider and
// the array form.
const stripLegacyIdeMode: ConfigMigration['apply'] = (parsed) => {
  const ide = parsed.ide

  if (ide === null || typeof ide !== 'object') {
    return { changed: false, result: parsed }
  }

  let changed = false

  const stripEntry = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object' || !('config' in entry)) {
      return entry
    }

    const config = (entry as { config: unknown }).config

    if (config === null || typeof config !== 'object' || !('mode' in config)) {
      return entry
    }

    changed = true

    return { ...(entry as Record<string, unknown>), config: omitKey(config as Record<string, unknown>, 'mode') }
  }

  const nextIde = Array.isArray(ide) ? ide.map(stripEntry) : stripEntry(ide)

  if (!changed) {
    return { changed: false, result: parsed }
  }

  return { changed: true, result: { ...parsed, ide: nextIde } }
}

export const stripLegacyIdeModeMigration: ConfigMigration = {
  id: 'strip-legacy-ide-mode',
  note: 'legacy "mode"',
  apply: stripLegacyIdeMode,
}
