import { DEPLOY_CONFIG_FILE } from '@slip-stream-kit/config/internal'
import type { DeployConfig } from '@slip-stream-kit/config/internal'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  GENERATED_MARKER,
  PILOT_WORKFLOW_PATHS,
  V1_WORKFLOW_PATHS,
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

const generatedAmong = async (root: string, paths: string[]): Promise<{ path: string; absolute: string }[]> => {
  const found = await Promise.all(
    paths.map(async (filePath) => {
      const absolute = path.join(root, filePath)
      const content = await readIfExists(absolute)

      return content?.startsWith(GENERATED_MARKER) ? [{ path: filePath, absolute }] : []
    }),
  )

  return found.flat()
}

/**
 * The generated `-v2` pilot pair, stale once the manifest `replaceV1`. Only a file carrying the
 * generated marker counts, so a hand-written file is never removed.
 */
const stalePilotFiles = async (
  root: string,
  config: DeployConfig,
): Promise<{ path: string; absolute: string; status: 'removed' }[]> => {
  if (config.replaceV1 !== true) return []

  return (await generatedAmong(root, PILOT_WORKFLOW_PATHS)).map((file) => {
    return { ...file, status: 'removed' as const }
  })
}

/** A `deploy` path that names no file would only fail when that service deploys. */
const assertDeployScriptsExist = async (root: string, config: DeployConfig): Promise<void> => {
  const missing = await Promise.all(
    Object.entries(config.services).map(async ([name, service]) => {
      if (service.deploy === undefined) return []

      return (await readIfExists(path.join(root, service.deploy))) === undefined ? [`${name}: ${service.deploy}`] : []
    }),
  )
  const names = missing.flat()

  if (names.length > 0) {
    throw new Error(`Deploy scripts named in ${DEPLOY_CONFIG_FILE} do not exist: ${names.join(', ')}`)
  }
}

/**
 * Turning `replaceV1` off must not delete the generated `deploy-all.yml`: delivery dispatches it, and
 * the hand-written v1 file it replaced lives only in git history.
 */
const assertNoGeneratedV1Files = async (root: string, config: DeployConfig): Promise<void> => {
  if (config.replaceV1 === true) return

  const generated = await generatedAmong(root, V1_WORKFLOW_PATHS)

  if (generated.length === 0) return

  const paths = generated
    .map((file) => {
      return file.path
    })
    .join(', ')

  throw new Error(
    `${paths} ${generated.length === 1 ? 'was' : 'were'} generated under replaceV1, which ${DEPLOY_CONFIG_FILE} no longer sets. Restore the hand-written v1 workflows from git history (or set replaceV1 again) before syncing.`,
  )
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

  await assertNoGeneratedV1Files(root, config)
  await assertDeployScriptsExist(root, config)

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
  const stale = await stalePilotFiles(root, config)

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
