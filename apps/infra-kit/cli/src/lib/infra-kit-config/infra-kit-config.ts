import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'yaml'
import { z } from 'zod/v4'

import { getProjectRoot } from 'src/lib/git-utils'

const INFRA_KIT_CONFIG_FILE = 'infra-kit.yml'
const INFRA_KIT_LOCAL_CONFIG_FILE = 'infra-kit.local.yml'

// envManagement
const dopplerEnvManagementSchema = z.object({
  provider: z.literal('doppler'),
  config: z.object({
    name: z.string().min(1),
  }),
})

const envManagementSchema = z.discriminatedUnion('provider', [dopplerEnvManagementSchema])

// ide
const cursorIdeConfigSchema = z
  .object({
    mode: z.enum(['workspace', 'windows']).default('workspace'),
    workspaceConfigPath: z.string().min(1).optional(),
  })
  .refine(
    (v) => {
      return v.mode !== 'workspace' || !!v.workspaceConfigPath
    },
    {
      message: 'workspaceConfigPath is required when mode is "workspace"',
      path: ['workspaceConfigPath'],
    },
  )

const cursorIdeSchema = z.object({
  provider: z.literal('cursor'),
  config: cursorIdeConfigSchema,
})

const ideSchema = z.discriminatedUnion('provider', [cursorIdeSchema])

// taskManager
const jiraTaskManagerSchema = z.object({
  provider: z.literal('jira'),
  config: z.object({
    baseUrl: z.string().url(),
    projectId: z.number().int().positive(),
  }),
})

const taskManagerSchema = z.discriminatedUnion('provider', [jiraTaskManagerSchema])

const infraKitConfigSchema = z.object({
  environments: z.array(z.string().min(1)).min(1),
  envManagement: envManagementSchema,
  ide: ideSchema.optional(),
  taskManager: taskManagerSchema.optional(),
})

const infraKitLocalConfigSchema = infraKitConfigSchema.partial()

export type InfraKitConfig = z.infer<typeof infraKitConfigSchema>

interface CacheEntry {
  mainMtimeMs: number
  localMtimeMs: number | null
  value: InfraKitConfig
}

let cached: CacheEntry | null = null

/**
 * Read and validate `infra-kit.yml`, with optional `infra-kit.local.yml` overrides
 * shallow-merged on top (per-developer, gitignored). Top-level keys (entire
 * capability sections like `ide`, `envManagement`) replace wholesale. Results are
 * cached per file mtimes so the long-running MCP server picks up edits without a
 * restart.
 */
export const getInfraKitConfig = async (): Promise<InfraKitConfig> => {
  const projectRoot = await getProjectRoot()
  const mainPath = path.join(projectRoot, INFRA_KIT_CONFIG_FILE)
  const localPath = path.join(projectRoot, INFRA_KIT_LOCAL_CONFIG_FILE)

  let mainStat: Awaited<ReturnType<typeof fs.stat>>

  try {
    mainStat = await fs.stat(mainPath)
  } catch {
    cached = null
    throw new Error(`infra-kit.yml not found at ${mainPath}`)
  }

  const localStat = await statIfExists(localPath)
  const mainMtimeMs = Number(mainStat.mtimeMs)
  const localMtimeMs = localStat ? Number(localStat.mtimeMs) : null

  if (cached && cached.mainMtimeMs === mainMtimeMs && cached.localMtimeMs === localMtimeMs) {
    return cached.value
  }

  const mainRaw = await fs.readFile(mainPath, 'utf-8')
  const mainParsed = yaml.parse(mainRaw)

  let merged: unknown = mainParsed

  if (localStat) {
    const localRaw = await fs.readFile(localPath, 'utf-8')
    const localParsedRaw = yaml.parse(localRaw) ?? {}

    const localResult = infraKitLocalConfigSchema.safeParse(localParsedRaw)

    if (!localResult.success) {
      throw new Error(`Invalid infra-kit.local.yml at ${localPath}: ${z.prettifyError(localResult.error)}`)
    }

    merged = { ...(mainParsed as object), ...localResult.data }
  }

  const result = infraKitConfigSchema.safeParse(merged)

  if (!result.success) {
    throw new Error(`Invalid infra-kit.yml at ${mainPath}: ${z.prettifyError(result.error)}`)
  }

  cached = { mainMtimeMs, localMtimeMs, value: result.data }

  return result.data
}

/** For tests — drops the in-memory cache. */
export const resetInfraKitConfigCache = (): void => {
  cached = null
}

const statIfExists = async (filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> => {
  try {
    return await fs.stat(filePath)
  } catch {
    return null
  }
}
