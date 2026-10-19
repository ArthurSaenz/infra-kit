import { DEPLOY_CONFIG_FILE } from '@slip-stream-kit/config/internal'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  GENERATED_MARKER,
  GENERATED_WORKFLOW_PATHS,
  loadDeployConfig,
  renderDeployWorkflows,
} from 'src/lib/deploy-workflows'
import { getProjectRoot } from 'src/lib/git-utils'
import { logger } from 'src/lib/logger'
import { textContent } from 'src/types'

type DeploySyncStatus = 'written' | 'unchanged' | 'drift' | 'missing-config'

type FileStatus = 'created' | 'updated' | 'unchanged' | 'removed'

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

const CHECK_LABEL: Record<FileStatus, string> = {
  created: 'missing',
  updated: 'differs',
  unchanged: 'matches',
  removed: 'no longer generated',
}

/**
 * Files an earlier sync generated under the other naming (the `-v2` pilot pair once the manifest
 * `replaceV1`, or back). Only a file carrying the generated marker counts: a hand-written v1 file is
 * never removed.
 */
const staleGeneratedFiles = async (
  root: string,
  current: { path: string }[],
): Promise<{ path: string; absolute: string; status: 'removed' }[]> => {
  const currentPaths = new Set(
    current.map((file) => {
      return file.path
    }),
  )
  const candidates = GENERATED_WORKFLOW_PATHS.filter((filePath) => {
    return !currentPaths.has(filePath)
  })
  const found = await Promise.all(
    candidates.map(async (filePath) => {
      const absolute = path.join(root, filePath)
      const content = await readIfExists(absolute)

      return content?.startsWith(GENERATED_MARKER) ? [{ path: filePath, absolute, status: 'removed' as const }] : []
    }),
  )

  return found.flat()
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
  const stale = await staleGeneratedFiles(root, files)

  const changed = [
    ...files.filter((file) => {
      return file.status !== 'unchanged'
    }),
    ...stale,
  ]
  const summary = [...files, ...stale].map(({ path: filePath, status }) => {
    return { path: filePath, status }
  })

  if (changed.length === 0) {
    logger.info(`✅ Deploy workflows match ${DEPLOY_CONFIG_FILE}.`)

    return result({ status: 'unchanged', ok: true, files: summary })
  }

  if (options.check) {
    logger.error(`❌ Deploy workflows differ from ${DEPLOY_CONFIG_FILE}; run \`infra-kit deploy-sync\` and commit:`)

    for (const file of changed) logger.error(`  ${file.path} (${CHECK_LABEL[file.status]})`)

    return result({ status: 'drift', ok: false, files: summary })
  }

  for (const file of changed) {
    if (file.status === 'removed') {
      await fs.rm(file.absolute)
      logger.info(`🗑️  Removed ${file.path}`)
      continue
    }

    await fs.mkdir(path.dirname(file.absolute), { recursive: true })
    await fs.writeFile(file.absolute, file.content)
    logger.info(`✏️  ${file.status === 'created' ? 'Created' : 'Updated'} ${file.path}`)
  }

  return result({ status: 'written', ok: true, files: summary })
}
