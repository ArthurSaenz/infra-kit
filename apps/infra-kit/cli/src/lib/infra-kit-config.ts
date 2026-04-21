import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'yaml'
import { z } from 'zod'

import { getProjectRoot } from 'src/lib/git-utils'

const INFRA_KIT_CONFIG_FILE = 'infra-kit.yml'

const jiraTaskManagerProviderSchema = z.object({
  type: z.literal('jira'),
  baseUrl: z.string().url(),
  projectId: z.number().int().positive(),
})

const infraKitConfigSchema = z.object({
  dopplerProjectName: z.string().min(1),
  environments: z.array(z.string().min(1)).min(1),
  taskManagerProvider: z.union([z.string(), z.literal(false), jiraTaskManagerProviderSchema]),
})

export type InfraKitConfig = z.infer<typeof infraKitConfigSchema>

interface CacheEntry {
  mtimeMs: number
  value: InfraKitConfig
}

let cached: CacheEntry | null = null

/**
 * Read and validate infra-kit.yml. Results are cached per file mtime so the
 * long-running MCP server picks up edits without a restart — if the user edits
 * infra-kit.yml mid-session, the next call re-reads it.
 */
export const getInfraKitConfig = async (): Promise<InfraKitConfig> => {
  const projectRoot = await getProjectRoot()
  const configPath = path.join(projectRoot, INFRA_KIT_CONFIG_FILE)

  let stat: Awaited<ReturnType<typeof fs.stat>>

  try {
    stat = await fs.stat(configPath)
  } catch {
    cached = null
    throw new Error(`infra-kit.yml not found at ${configPath}`)
  }

  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.value
  }

  const raw = await fs.readFile(configPath, 'utf-8')
  const parsed = yaml.parse(raw)
  const result = infraKitConfigSchema.safeParse(parsed)

  if (!result.success) {
    throw new Error(`Invalid infra-kit.yml at ${configPath}: ${result.error.message}`)
  }

  cached = { mtimeMs: stat.mtimeMs, value: result.data }

  return result.data
}

/** For tests — drops the in-memory cache. */
export const resetInfraKitConfigCache = (): void => {
  cached = null
}
