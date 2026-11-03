import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { GuidanceWrite } from 'src/lib/agent-guidance'
import {
  appendTopLevelMembers,
  detectIndent,
  prependTopLevelMembers,
  replaceTopLevelValue,
  writeConfigFileText,
} from 'src/lib/config-migrations'
import { SUPPORTED_CONFIG_VERSION, configSchemaUrl } from 'src/lib/infra-kit-config'
import { PACKAGE_CONFIG_FILE, loadAuthoredPackageConfig } from 'src/lib/package-validator/loader'
import { isNewerVersion } from 'src/lib/update-check/semver'

const PROJECT_CONFIG_FILE = 'infra-kit.json'

/** The package-config keys that carry audit rules — the only ones the root ever used. */
const AUDIT_KEYS = ['requiredScripts', 'requiredFiles', 'turbo'] as const

const failed = (filePath: string, message: string): GuidanceWrite[] => {
  return [{ path: filePath, action: 'failed', message }]
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Move a retired root `infra-kit.config.ts` into the project `infra-kit.json` `audit` block, then
 * delete it. The rules are copied as authored (an explicit `[]` stays an explicit `[]`), so the
 * root audit checks exactly what it checked before.
 *
 * Refuses, leaving both files untouched, when the config carries keys that mean nothing at the
 * root or `infra-kit.json` already has an `audit` block — either way a human has to decide.
 *
 * @example
 * await migrateRootAuditConfig('/repo')
 * // => [{ path: '/repo/infra-kit.json', action: 'updated' }, { path: '/repo/infra-kit.config.ts', action: 'removed' }]
 */
export const migrateRootAuditConfig = async (repoRoot: string): Promise<GuidanceWrite[]> => {
  const tsPath = path.join(repoRoot, PACKAGE_CONFIG_FILE)
  const jsonPath = path.join(repoRoot, PROJECT_CONFIG_FILE)

  let loaded: Awaited<ReturnType<typeof loadAuthoredPackageConfig>>

  try {
    loaded = await loadAuthoredPackageConfig(repoRoot)
  } catch (err) {
    return failed(tsPath, (err as Error).message)
  }

  if (!loaded) return []

  const authored: Record<string, unknown> = { ...loaded }

  const foreignKeys = Object.keys(authored).filter((key) => {
    return !(AUDIT_KEYS as readonly string[]).includes(key)
  })

  if (foreignKeys.length > 0) {
    return failed(
      tsPath,
      `declares ${foreignKeys.join(', ')}, which mean nothing at the repo root — remove them, then re-run`,
    )
  }

  const rules = Object.fromEntries(
    AUDIT_KEYS.filter((key) => {
      return authored[key] !== undefined
    }).map((key) => {
      return [key, authored[key]]
    }),
  )

  const written: GuidanceWrite[] = []

  if (Object.keys(rules).length > 0) {
    try {
      const stat = await fs.stat(jsonPath)
      const raw = await fs.readFile(jsonPath, 'utf8')
      const current: unknown = JSON.parse(raw)

      if (!isRecord(current)) {
        return failed(jsonPath, 'is not a JSON object')
      }

      if ('audit' in current) {
        return failed(
          jsonPath,
          `already has an "audit" block — merge ${PACKAGE_CONFIG_FILE}'s rules into it by hand, then delete ${PACKAGE_CONFIG_FILE}`,
        )
      }

      const content = appendTopLevelMembers(raw, [['audit', rules]], detectIndent(raw))

      if (content === null || !isDeepStrictEqual(JSON.parse(content), { ...current, audit: rules })) {
        return failed(jsonPath, 'could not add the "audit" block without rewriting the file — add it by hand')
      }

      await writeConfigFileText({ path: jsonPath, content, expectedMtimeMs: stat.mtimeMs })
      written.push({ path: jsonPath, action: 'updated' })
    } catch (err) {
      return failed(jsonPath, (err as Error).message)
    }
  }

  try {
    await fs.rm(tsPath)
    written.push({ path: tsPath, action: 'removed' })
  } catch (err) {
    written.push({ path: tsPath, action: 'failed', message: (err as Error).message })
  }

  return written
}

/** The CLI version in a `$schema` this CLI stamped, or null for any other URL. */
const stampedSchemaVersion = (schema: unknown): string | null => {
  if (typeof schema !== 'string') return null

  return /^https:\/\/unpkg\.com\/infra-kit@([^/]+)\//.exec(schema)?.[1] ?? null
}

/**
 * `raw` with each stamp key's value replaced where the key exists, and the missing ones inserted first
 * (so the editor pointer and the version read before anything they describe). Every other byte is kept.
 */
const stampText = (raw: string, stamp: { $schema: unknown; configVersion: number }): string | null => {
  const missing: [string, unknown][] = []
  let text: string | null = raw

  for (const [key, value] of Object.entries(stamp)) {
    const replaced: string | null = text === null ? null : replaceTopLevelValue(text, key, value)

    if (replaced === null) missing.push([key, value])
    else text = replaced
  }

  return text === null ? null : prependTopLevelMembers(text, missing, detectIndent(raw))
}

/**
 * Stamp `$schema` (a version-pinned URL of this CLI's generated schema) and `configVersion` at the top of
 * the committed `infra-kit.json` — layer 1, the only layer that may carry `configVersion` — changing no
 * other byte of it, so a prettier-formatted file stays formatted. This and
 * `audit --fix --root` are the only writers of either key: the loader only reads them, and `doctor`
 * never writes the file.
 *
 * Left alone: a `$schema` that is not ours (someone pointed it at a schema of their own), one stamped by
 * a newer CLI (stamping it back would hand the editor an older schema than the file was written for),
 * and a file whose `configVersion` is above what this CLI reads.
 *
 * @example
 * await stampRootConfig('/repo', '0.42.0')
 * // => [{ path: '/repo/infra-kit.json', action: 'updated' }]   (or [] when already stamped)
 */
export const stampRootConfig = async (repoRoot: string, version: string): Promise<GuidanceWrite[]> => {
  const jsonPath = path.join(repoRoot, PROJECT_CONFIG_FILE)

  try {
    const stat = await fs.stat(jsonPath)
    const raw = await fs.readFile(jsonPath, 'utf8')
    const current: unknown = JSON.parse(raw)

    if (!isRecord(current)) return failed(jsonPath, 'is not a JSON object')

    if (typeof current.configVersion === 'number' && current.configVersion > SUPPORTED_CONFIG_VERSION) {
      return failed(
        jsonPath,
        `declares configVersion ${current.configVersion}; this CLI reads up to ${SUPPORTED_CONFIG_VERSION}`,
      )
    }

    const stampedBy = stampedSchemaVersion(current.$schema)

    const keepSchema =
      (current.$schema !== undefined && stampedBy === null) ||
      (stampedBy !== null && isNewerVersion(stampedBy, version))

    const $schema = keepSchema ? current.$schema : configSchemaUrl(version)

    if (current.$schema === $schema && current.configVersion === SUPPORTED_CONFIG_VERSION) return []

    const content = stampText(raw, { $schema, configVersion: SUPPORTED_CONFIG_VERSION })

    // The splice is checked, not trusted: a file the scanner misread would otherwise be written broken.
    if (
      content === null ||
      !isDeepStrictEqual(JSON.parse(content), { ...current, $schema, configVersion: SUPPORTED_CONFIG_VERSION })
    ) {
      return failed(jsonPath, 'could not insert $schema/configVersion without rewriting the file — add them by hand')
    }

    await writeConfigFileText({ path: jsonPath, content, expectedMtimeMs: stat.mtimeMs })

    return [{ path: jsonPath, action: 'updated' }]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []

    return failed(jsonPath, (err as Error).message)
  }
}
