import process from 'node:process'
import { $ } from 'zx'

import { seedCreatedMessage, seedUserProjectConfig } from 'src/lib/config-bootstrap'
import { describeOverrides, readOverrideSummary } from 'src/lib/config-overrides'
import { getInfraKitConfigPaths, resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { fileExists, tildify } from 'src/lib/path-display'
import type { ToolsExecutionResult } from 'src/types'

/**
 * Print the file paths that participate in the config merge chain along with existence markers, so
 * the user can see at a glance which override layers are active. The user-project row additionally
 * reports its CONTENT — an auto-seeded empty file is indistinguishable from a real one by existence
 * alone, since every command now seeds layer 3.
 *
 * `layers[].exists` keeps its original meaning (the file exists) and still drives the markers;
 * `hasOverrides` / `overrideKeys` are top-level additions describing the user-project layer only.
 *
 * @example
 * // CLI: `infra-kit config path`
 * // INFO: Project name: api
 * // INFO: Config merge chain (later overrides earlier):
 * // INFO:   [✓] project (committed)    ~/projects/api/infra-kit.json
 * // INFO:   [ ] user global            ~/.infra-kit/infra-kit.json
 * // INFO:   [✓] user project           ~/.infra-kit/projects/api/infra-kit.json (2 override(s): ide, dev)
 */
export const configPath = async (): Promise<ToolsExecutionResult> => {
  const paths = await getInfraKitConfigPaths()

  const rows: { label: string; path: string; exists: boolean }[] = await Promise.all(
    [
      { label: 'project (committed)', path: paths.main },
      { label: 'user global', path: paths.userGlobal },
      { label: 'user project', path: paths.userProject },
    ].map(async (row) => {
      return { ...row, exists: await fileExists(row.path) }
    }),
  )

  const userProjectExists = rows.at(-1)?.exists === true
  const summary = await readOverrideSummary(paths.userProject, userProjectExists)
  // Absent layer-3: no suffix — the `[ ]` marker already says it. (`doctor` owns the louder
  // "the seed should have created this" reading of the same state.)
  const note = userProjectExists ? describeOverrides(summary) : ''

  logger.info(`Project name: ${paths.projectName}\n`)
  logger.info('Config merge chain (later overrides earlier):\n')

  for (const row of rows) {
    const marker = row.exists ? '  [✓]' : '  [ ]'
    const suffix = row.path === paths.userProject && note !== '' ? ` ${note}` : ''

    logger.info(`${marker} ${row.label.padEnd(22)} ${tildify(row.path)}${suffix}`)
  }

  const structuredContent = {
    projectName: paths.projectName,
    layers: rows.map((r) => {
      return { label: r.label, path: r.path, exists: r.exists }
    }),
    hasOverrides: summary.hasOverrides,
    overrideKeys: summary.overrideKeys,
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  }
}

/**
 * Open the user-scope per-project override file in $EDITOR, creating it (and refreshing its
 * annotated `.example.jsonc` sibling) on first use. Resets the config cache after the editor exits
 * so subsequent reads pick up the user's edits without a restart.
 *
 * This double-seeds in practice: the program's preAction hook already ran the gated
 * `ensureUserProjectConfig()`, and this runs the ungated primitive again. `seedUserProjectConfig` is
 * idempotent (zero writes in steady state), so that is harmless — and the ungated call must STAY: it
 * is what makes `config edit` work in a context where the gate declined (no committed project
 * config, `INFRA_KIT_NO_SEED`, or a seed that failed). Asking to edit the file is consent to create
 * it.
 *
 * @example
 * // CLI: `infra-kit config edit`
 * // first run — creates ~/.infra-kit/projects/api/infra-kit.json ({}) + a sibling
 * //             infra-kit.example.jsonc reference, then $EDITOR opens the .json
 * // subsequent runs — opens the existing file as-is (a stale example is refreshed silently)
 */
export const configEdit = async (): Promise<ToolsExecutionResult> => {
  const paths = await getInfraKitConfigPaths()
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi'

  const seed = await seedUserProjectConfig(paths)

  if (seed.createdConfig) {
    logger.info(seedCreatedMessage(seed))
  }

  logger.info(`Opening ${tildify(paths.userProject)} in ${editor}`)

  await $({ stdio: 'inherit' })`${editor} ${paths.userProject}`

  resetInfraKitConfigCache()

  const structuredContent = { path: paths.userProject, editor }

  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  }
}
