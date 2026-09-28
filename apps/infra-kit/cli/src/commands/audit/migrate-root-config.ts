import fs from 'node:fs/promises'
import path from 'node:path'

import type { GuidanceWrite } from 'src/lib/agent-guidance'
import { writeMigratedConfigFile } from 'src/lib/config-migrations'
import { PACKAGE_CONFIG_FILE, loadAuthoredPackageConfig } from 'src/lib/package-validator/loader'

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

      await writeMigratedConfigFile({
        path: jsonPath,
        raw,
        migrated: { ...current, audit: rules },
        expectedMtimeMs: stat.mtimeMs,
      })
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
