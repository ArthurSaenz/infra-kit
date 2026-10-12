import { DEPLOY_CONFIG_FILE } from '@slip-stream-kit/config/internal'
import fs from 'node:fs/promises'
import path from 'node:path'

import { loadDeployConfig, renderDeployWorkflows } from 'src/lib/deploy-workflows'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { textContent } from 'src/types'

type DeploySyncStatus = 'written' | 'unchanged' | 'drift' | 'missing-config'

type FileStatus = 'created' | 'updated' | 'unchanged'

interface DeploySyncOptions {
  /** Compare only; never write. A difference makes the result not ok. */
  check?: boolean
  /** Repo root. Defaults to the git toplevel. */
  cwd?: string
}

const readIfExists = async (filePath: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return undefined
  }
}

const result = (structuredContent: {
  status: DeploySyncStatus
  ok: boolean
  files: { path: string; status: FileStatus }[]
}) => {
  return { content: textContent(JSON.stringify(structuredContent, null, 2)), structuredContent }
}

/**
 * Generate the repo's deploy workflows from its `infra-kit.deploy.ts`, or with `check` report whether
 * the committed ones still match it. CI then runs the generated YAML and never needs this CLI.
 *
 * Never calls `process.exit`: the CLI action maps `structuredContent.ok` to the exit code.
 *
 * @example
 * await deploySync()                 // writes .github/workflows/deploy-{all,selected}-v2.yml
 * await deploySync({ check: true })  // ok=false when either file differs from the manifest
 */
export const deploySync = async (options: DeploySyncOptions = {}) => {
  const root = options.cwd ?? (await getProjectRoot())
  const config = await loadDeployConfig(root)

  if (config === undefined) {
    // Nothing to keep in sync is not a failure for `--check`, so a CI step can run in any repo.
    const log = options.check ? logger.info.bind(logger) : logger.error.bind(logger)

    log(`No ${DEPLOY_CONFIG_FILE} at ${root}, nothing to generate.`)

    return result({ status: 'missing-config', ok: Boolean(options.check), files: [] })
  }

  const files = await Promise.all(
    renderDeployWorkflows(config).map(async (workflow) => {
      const absolute = path.join(root, workflow.path)
      const current = await readIfExists(absolute)

      let status: FileStatus = 'unchanged'

      if (current === undefined) status = 'created'
      else if (current !== workflow.content) status = 'updated'

      return { ...workflow, absolute, status }
    }),
  )

  const changed = files.filter((file) => {
    return file.status !== 'unchanged'
  })
  const summary = files.map(({ path: filePath, status }) => {
    return { path: filePath, status }
  })

  if (changed.length === 0) {
    logger.info(`✅ Deploy workflows match ${DEPLOY_CONFIG_FILE}.`)

    return result({ status: 'unchanged', ok: true, files: summary })
  }

  if (options.check) {
    logger.error(`❌ Deploy workflows differ from ${DEPLOY_CONFIG_FILE}; run \`infra-kit deploy-sync\` and commit:`)

    for (const file of changed) logger.error(`  ${file.path} (${file.status === 'created' ? 'missing' : 'differs'})`)

    return result({ status: 'drift', ok: false, files: summary })
  }

  for (const file of changed) {
    await fs.mkdir(path.dirname(file.absolute), { recursive: true })
    await fs.writeFile(file.absolute, file.content)
    logger.info(`✏️  ${file.status === 'created' ? 'Created' : 'Updated'} ${file.path}`)
  }

  return result({ status: 'written', ok: true, files: summary })
}
