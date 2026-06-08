import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import yaml from 'yaml'
import { z } from 'zod'

import { getProjectRoot, getRepoName } from 'src/lib/git-utils'

const INFRA_KIT_CONFIG_FILE = 'infra-kit.yml'

const USER_CONFIG_DIR_NAME = '.infra-kit'
const USER_GLOBAL_CONFIG_FILE = 'config.yml'
const USER_PROJECTS_DIR = 'projects'

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

// worktrees prompt defaults
const worktreesConfigSchema = z.object({
  openInGithubDesktop: z.boolean().optional(),
  openInCmux: z.boolean().optional(),
})

const infraKitConfigSchema = z.object({
  environments: z.array(z.string().min(1)).min(1),
  envManagement: envManagementSchema,
  ide: ideSchema.optional(),
  taskManager: taskManagerSchema.optional(),
  worktrees: worktreesConfigSchema.optional(),
})

const infraKitOverrideConfigSchema = infraKitConfigSchema.partial()

export type InfraKitConfig = z.infer<typeof infraKitConfigSchema>

export interface InfraKitConfigPaths {
  /** Committed project config (required). */
  main: string
  /** User-scope global overrides applied to every project. */
  userGlobal: string
  /** User-scope per-project overrides — `<userProjectsDir>/<projectName>/infra-kit.yml`. */
  userProject: string
  /** Repo basename (`path.basename(projectRoot)`) used to namespace the user-project file. */
  projectName: string
}

interface CacheEntry {
  mtimes: Record<keyof Omit<InfraKitConfigPaths, 'projectName'>, number | null>
  value: InfraKitConfig
}

let cached: CacheEntry | null = null

/**
 * Resolve every file path that participates in the config merge chain. Always
 * returns paths even for files that don't yet exist, so callers can use them
 * for "where would my override go?" prompts.
 *
 * @example
 * const paths = await getInfraKitConfigPaths()
 * // {
 * //   main:        '/Users/arthur/projects/api/infra-kit.yml',
 * //   userGlobal:  '/Users/arthur/.infra-kit/config.yml',
 * //   userProject: '/Users/arthur/.infra-kit/projects/api/infra-kit.yml',
 * //   projectName: 'api',
 * // }
 */
export const getInfraKitConfigPaths = async (): Promise<InfraKitConfigPaths> => {
  const projectRoot = await getProjectRoot()
  const projectName = await getRepoName()
  const userConfigDir = path.join(os.homedir(), USER_CONFIG_DIR_NAME)

  return {
    main: path.join(projectRoot, INFRA_KIT_CONFIG_FILE),
    userGlobal: path.join(userConfigDir, USER_GLOBAL_CONFIG_FILE),
    userProject: path.join(userConfigDir, USER_PROJECTS_DIR, projectName, INFRA_KIT_CONFIG_FILE),
    projectName,
  }
}

/**
 * Read and validate `infra-kit.yml`, with optional override layers shallow-merged
 * on top in this order (later wins):
 *   1. project `infra-kit.yml`                            — committed source of truth
 *   2. `~/.infra-kit/config.yml`                          — user-global defaults
 *   3. `~/.infra-kit/projects/<repo-name>/infra-kit.yml`  — user-scope per-project overrides
 *
 * Top-level keys (entire capability sections like `ide`, `envManagement`)
 * replace wholesale. Results are cached per file mtimes so the long-running
 * MCP server picks up edits without a restart.
 *
 * @example
 * // infra-kit.yml:           { environments: ['dev'], envManagement: { provider: 'doppler', config: { name: 'p' } } }
 * // ~/.infra-kit/config.yml: { ide: { provider: 'cursor', config: { mode: 'windows' } } }
 * const cfg = await getInfraKitConfig()
 * // => { environments: ['dev'], envManagement: {...}, ide: { provider: 'cursor', config: { mode: 'windows' } } }
 */
export const getInfraKitConfig = async (): Promise<InfraKitConfig> => {
  const paths = await getInfraKitConfigPaths()

  let mainStat: Awaited<ReturnType<typeof fs.stat>>

  try {
    mainStat = await fs.stat(paths.main)
  } catch {
    cached = null
    throw new Error(`infra-kit.yml not found at ${paths.main}`)
  }

  const [userGlobalStat, userProjectStat] = await Promise.all([
    statIfExists(paths.userGlobal),
    statIfExists(paths.userProject),
  ])

  const mtimes = {
    main: Number(mainStat.mtimeMs),
    userGlobal: userGlobalStat ? Number(userGlobalStat.mtimeMs) : null,
    userProject: userProjectStat ? Number(userProjectStat.mtimeMs) : null,
  }

  if (cached && shallowEqual(cached.mtimes, mtimes)) {
    return cached.value
  }

  const layers: ConfigLayer[] = [
    { label: 'infra-kit.yml', path: paths.main, required: true },
    { label: '~/.infra-kit/config.yml', path: paths.userGlobal, required: false },
    {
      label: `~/.infra-kit/projects/${paths.projectName}/infra-kit.yml`,
      path: paths.userProject,
      required: false,
    },
  ]

  let merged: Record<string, unknown> = {}

  for (const layer of layers) {
    const data = await loadLayer(layer)

    if (data === null) continue

    merged = { ...merged, ...data }
  }

  const finalResult = infraKitConfigSchema.safeParse(merged)

  if (!finalResult.success) {
    throw new Error(`Invalid merged infra-kit config: ${z.prettifyError(finalResult.error)}`)
  }

  cached = { mtimes, value: finalResult.data }

  return finalResult.data
}

/**
 * For tests — drops the in-memory cache so the next read hits disk.
 *
 * @example
 * resetInfraKitConfigCache()
 * await getInfraKitConfig() // re-reads files even if mtimes look unchanged
 */
export const resetInfraKitConfigCache = (): void => {
  cached = null
}

/**
 * `fs.stat` that returns `null` instead of throwing on ENOENT. Used so the
 * resolver can probe optional files in the merge chain without try/catch noise.
 *
 * @example
 * const stat = await statIfExists('/does/not/exist') // => null
 */
const statIfExists = async (filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> => {
  try {
    return await fs.stat(filePath)
  } catch {
    return null
  }
}

/**
 * `fs.readFile` that returns `null` instead of throwing on ENOENT.
 *
 * @example
 * const raw = await readIfExists('/missing.yml') // => null
 * const raw = await readIfExists('/exists.yml')  // => 'environments: [dev]\n'
 */
const readIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Reference-equality comparison of every key in two flat records. Used to
 * cheaply detect whether the cached mtime fingerprint still matches.
 *
 * @example
 * shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 }) // => true
 * shallowEqual({ a: 1 },       { a: 1, b: 2 }) // => false
 * shallowEqual({ a: 1 },       { a: 2 })       // => false
 */
const shallowEqual = <T extends Record<string, unknown>>(a: T, b: T): boolean => {
  const keys = Object.keys(a)

  if (keys.length !== Object.keys(b).length) return false

  return keys.every((k) => {
    return a[k] === b[k]
  })
}

interface ConfigLayer {
  label: string
  path: string
  required: boolean
}

/**
 * Read a single layer of the merge chain: parse the YAML if the file exists
 * and validate it against the override schema. Returns `null` if an optional
 * layer is missing; throws if the layer is required or invalid.
 *
 * @example
 * await loadLayer({ label: '~/.infra-kit/config.yml', path: '/missing.yml', required: false })
 * // => null
 *
 * @example
 * // /home/me/.infra-kit/config.yml: 'ide:\n  provider: cursor\n  config: { mode: windows }'
 * await loadLayer({ label: '~/.infra-kit/config.yml', path: '/home/me/.infra-kit/config.yml', required: false })
 * // => { ide: { provider: 'cursor', config: { mode: 'windows' } } }
 */
const loadLayer = async (layer: ConfigLayer): Promise<Record<string, unknown> | null> => {
  const raw = await readIfExists(layer.path)

  if (raw === null) {
    if (layer.required) {
      throw new Error(`${layer.label} not found at ${layer.path}`)
    }

    return null
  }

  const parsedRaw = yaml.parse(raw) ?? {}
  const result = infraKitOverrideConfigSchema.safeParse(parsedRaw)

  if (!result.success) {
    throw new Error(`Invalid ${layer.label} at ${layer.path}: ${z.prettifyError(result.error)}`)
  }

  return result.data as Record<string, unknown>
}
