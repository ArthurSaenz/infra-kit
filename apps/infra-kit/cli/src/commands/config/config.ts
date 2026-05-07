import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { $ } from 'zx'

import { getInfraKitConfigPaths, resetInfraKitConfigCache } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import type { ToolsExecutionResult } from 'src/types'

/**
 * Resolve whether a file is reachable, suppressing ENOENT into a boolean.
 *
 * @example
 * await fileExists('/etc/hosts')   // => true
 * await fileExists('/nope.txt')    // => false
 */
const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath)

    return true
  } catch {
    return false
  }
}

/**
 * Replace the user's home prefix with `~` so logged paths stay short and
 * portable across machines. Leaves non-home paths untouched.
 *
 * @example
 * // os.homedir() === '/Users/arthur'
 * tildify('/Users/arthur/.infra-kit/config.yml') // => '~/.infra-kit/config.yml'
 * tildify('/etc/hosts')                          // => '/etc/hosts'
 */
const tildify = (filePath: string): string => {
  const home = os.homedir()

  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath
}

/**
 * Print the file paths that participate in the config merge chain along with
 * existence markers, so the user can see at a glance which override layers
 * are active.
 *
 * @example
 * // CLI: `infra-kit config path`
 * // INFO: Project name: api
 * // INFO: Config merge chain (later overrides earlier):
 * // INFO:   [✓] project (committed)    ~/projects/api/infra-kit.yml
 * // INFO:   [ ] user global            ~/.infra-kit/config.yml
 * // INFO:   [✓] user project           ~/.infra-kit/projects/api/infra-kit.yml
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
 * // first run — creates ~/.infra-kit/projects/api/infra-kit.yml from a stub, then $EDITOR opens it
 * // subsequent runs — opens the existing file as-is
 */
export const configEdit = async (): Promise<ToolsExecutionResult> => {
  const paths = await getInfraKitConfigPaths()
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi'

  await fs.mkdir(path.dirname(paths.userProject), { recursive: true })

  if (!(await fileExists(paths.userProject))) {
    const stub = `# infra-kit user override for ${paths.projectName}\n# This file is shallow-merged on top of project infra-kit.yml.\n# Top-level keys (envManagement, ide, taskManager, environments) replace wholesale.\n`

    await fs.writeFile(paths.userProject, stub, 'utf-8')
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
