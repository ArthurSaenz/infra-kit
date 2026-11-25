import fs from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

import {
  detectIndent,
  prependTopLevelMembers,
  replaceTopLevelValue,
  writeConfigFileText,
} from 'src/lib/config-migrations'
import { resetInfraKitConfigCache, resolveSchemaStamp, resolveUserGlobalConfigPath } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { tildify } from 'src/lib/path-display'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Point `~/.infra-kit/infra-kit.json` at this CLI's schema, changing no other byte of it. `setup` runs
 * it, and the update worker runs `setup` after every update, so the pointer follows the installed CLI
 * with no command from the user.
 *
 * `$schema` only: the loader refuses `configVersion` outside the committed project file.
 *
 * Non-fatal: a missing file is a no-op, and a malformed one, an I/O error or a file that changed
 * between the read and the write is logged and skipped — the next `setup` retries from fresh bytes.
 *
 * @example
 * await stampUserGlobalSchema('0.42.0')
 * // ✓ Stamped ~/.infra-kit/infra-kit.json ($schema → infra-kit 0.42.0)
 * // (no output when the file already names it, or names a schema that is not ours)
 */
export const stampUserGlobalSchema = async (version: string): Promise<void> => {
  const jsonPath = resolveUserGlobalConfigPath()

  try {
    const stat = await fs.stat(jsonPath)
    const raw = await fs.readFile(jsonPath, 'utf8')
    const current: unknown = JSON.parse(raw)

    if (!isRecord(current)) return

    const $schema = resolveSchemaStamp(current.$schema, version)

    if (current.$schema === $schema) return

    const content =
      replaceTopLevelValue(raw, '$schema', $schema) ??
      prependTopLevelMembers(raw, [['$schema', $schema]], detectIndent(raw))

    // The splice is checked, not trusted: a file the scanner misread would otherwise be written broken.
    if (content === null || !isDeepStrictEqual(JSON.parse(content), { ...current, $schema })) {
      logger.info(`⚠ Skipped ${tildify(jsonPath)} — could not insert $schema without rewriting the file`)

      return
    }

    await writeConfigFileText({ path: jsonPath, content, expectedMtimeMs: stat.mtimeMs })
    resetInfraKitConfigCache()

    logger.info(`✓ Stamped ${tildify(jsonPath)} ($schema → infra-kit ${version})`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return

    logger.info(`⚠ Skipped ${tildify(jsonPath)} — ${(err as Error).message}`)
  }
}
