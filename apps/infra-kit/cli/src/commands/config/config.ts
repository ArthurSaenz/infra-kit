import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { $ } from 'zx'

import { getInfraKitConfigPaths, resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { fileExists, tildify } from 'src/lib/path-display'
import type { ToolsExecutionResult } from 'src/types'

/**
 * Print the file paths that participate in the config merge chain along with
 * existence markers, so the user can see at a glance which override layers
 * are active.
 *
 * @example
 * // CLI: `infra-kit config path`
 * // INFO: Project name: api
 * // INFO: Config merge chain (later overrides earlier):
 * // INFO:   [✓] project (committed)    ~/projects/api/infra-kit.json
 * // INFO:   [ ] user global            ~/.infra-kit/infra-kit.json
 * // INFO:   [✓] user project           ~/.infra-kit/projects/api/infra-kit.json
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

  logger.info(`Project name: ${paths.projectName}\n`)
  logger.info('Config merge chain (later overrides earlier):\n')

  for (const row of rows) {
    const marker = row.exists ? '  [✓]' : '  [ ]'

    logger.info(`${marker} ${row.label.padEnd(22)} ${tildify(row.path)}`)
  }

  const structuredContent = {
    projectName: paths.projectName,
    layers: rows.map((r) => {
      return { label: r.label, path: r.path, exists: r.exists }
    }),
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  }
}

/**
 * Open the user-scope per-project override file in $EDITOR, creating the
 * parent directory and a stub file on first use. Resets the config cache
 * after the editor exits so subsequent reads pick up edits without a restart.
 *
 * @example
 * // CLI: `infra-kit config edit`
 * // first run — creates ~/.infra-kit/projects/api/infra-kit.json ({}) + a sibling
 * //             infra-kit.example.jsonc reference, then $EDITOR opens the .json
 * // subsequent runs — opens the existing file as-is
 */
export const configEdit = async (): Promise<ToolsExecutionResult> => {
  const paths = await getInfraKitConfigPaths()
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi'

  await fs.mkdir(path.dirname(paths.userProject), { recursive: true })

  if (!(await fileExists(paths.userProject))) {
    // JSON can't carry comments, so seed an empty-but-valid config and drop the
    // annotated guidance next to it in a non-loaded .example.jsonc the loader
    // never reads (it only globs the three exact `infra-kit.json` filenames).
    const examplePath = exampleSiblingPath(paths.userProject)

    await fs.writeFile(paths.userProject, '{}\n', 'utf-8')
    await fs.writeFile(examplePath, buildUserProjectExample(paths.projectName), 'utf-8')

    logger.info(`Created ${tildify(paths.userProject)} — see ${tildify(examplePath)} for the annotated reference.`)
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

/**
 * Derive the non-loaded `.example.jsonc` sibling for a config path.
 *
 * @example
 * exampleSiblingPath('/u/.infra-kit/projects/api/infra-kit.json')
 * // => '/u/.infra-kit/projects/api/infra-kit.example.jsonc'
 */
const exampleSiblingPath = (jsonPath: string): string => {
  return jsonPath.replace(/\.json$/, '.example.jsonc')
}

/**
 * Annotated JSONC reference for the user-scope per-project override layer.
 * Written alongside the real `{}` config so the guidance the old YAML stub
 * carried in comments survives the move to JSON.
 *
 * @example
 * buildUserProjectExample('api')
 * // => '// infra-kit user override for api …\n{ … }\n'
 */
const buildUserProjectExample = (projectName: string): string => {
  return `// infra-kit user override for ${projectName} — ~/.infra-kit/projects/${projectName}/infra-kit.json
//
// Layer 3 (highest precedence) of the config merge chain. Shallow-merged on top
// of <repo>/infra-kit.json and ~/.infra-kit/infra-kit.json — top-level keys
// (environments, envManagement, ide, taskManager, worktrees, envAutoLoad) replace wholesale.
//
// This .example.jsonc is reference only — it is NOT loaded. Put real overrides
// in the sibling infra-kit.json (strict JSON: no comments, double-quoted keys).
{
  // "worktrees": { "openInGithubDesktop": false, "openInCmux": true, "cmux": { "layout": "two-columns" } },
  // // Auto-load Doppler env here. trigger (pick one): shell-startup | cli-invocation; config: an environment name.
  // "envAutoLoad": { "trigger": "shell-startup", "config": "dev" }
}
`
}
