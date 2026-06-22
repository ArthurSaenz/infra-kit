import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

import { getProjectRoot, getRepoName } from 'src/lib/git-utils'

const INFRA_KIT_CONFIG_FILE = 'infra-kit.json'

const USER_CONFIG_DIR_NAME = '.infra-kit'
const USER_GLOBAL_CONFIG_FILE = 'config.json'
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
// There is one attach style: each worktree is added to the configured editor's
// workspace and opened (no per-window mode). Cursor needs a `.code-workspace`
// path to reconcile its `folders` array against.
const cursorIdeConfigSchema = z.object({
  workspaceConfigPath: z.string().min(1),
})

const cursorIdeSchema = z.object({
  provider: z.literal('cursor'),
  config: cursorIdeConfigSchema,
})

// Zed has no portable workspace file (no `.code-workspace`) and no folder-remove
// CLI: a multi-worktree workspace is realized by a single `zed <root> <wt...>`
// invocation. So `config` carries no settings — there's no path to point at.
const zedIdeConfigSchema = z.object({})

const zedIdeSchema = z.object({
  provider: z.literal('zed'),
  config: zedIdeConfigSchema,
})

const ideSchema = z.discriminatedUnion('provider', [cursorIdeSchema, zedIdeSchema])

// `ide` accepts a single provider (back-compat) OR an array to drive multiple
// editors at once (e.g. Cursor + Zed). Normalized to an array everywhere via
// `resolveConfiguredIdes`. Uniqueness-by-provider is enforced at parse time by a
// `.superRefine` on the full config schema (see below) — not here, so the message
// survives `z.union` error aggregation.
const idesSchema = z.union([ideSchema, z.array(ideSchema).min(1)])

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

// Base object shape, kept separate so `.partial()` (which only works on a plain
// ZodObject, not the `.superRefine`-wrapped full schema) can derive the override
// schema from it.
const infraKitConfigObject = z.object({
  environments: z.array(z.string().min(1)).min(1),
  envManagement: envManagementSchema,
  ide: idesSchema.optional(),
  taskManager: taskManagerSchema.optional(),
  worktrees: worktreesConfigSchema.optional(),
})

// Full schema = base object + a parse-time uniqueness check on the `ide` array.
// This runs inside the *merged* `safeParse` in getInfraKitConfig, so it's the
// gate for the final config. (The override layers use the `.partial()` form
// below, which drops this object-level refinement — acceptable, the merged
// parse is authoritative.)
export const infraKitConfigSchema = infraKitConfigObject.superRefine((cfg, ctx) => {
  if (!Array.isArray(cfg.ide)) return

  const seen = new Set<string>()

  for (const entry of cfg.ide) {
    if (seen.has(entry.provider)) {
      ctx.addIssue({
        code: 'custom',
        message: 'each IDE provider may appear at most once',
        path: ['ide'],
      })

      return
    }

    seen.add(entry.provider)
  }
})

export const infraKitOverrideConfigSchema = infraKitConfigObject.partial()

export type InfraKitConfig = z.infer<typeof infraKitConfigSchema>

/** A single resolved IDE entry (`{ provider, config }`). */
export type ConfiguredIde = z.infer<typeof ideSchema>

/**
 * Normalize the `ide` config (single object, array, or unset) into a flat list.
 * Validation-free: assumes already-parsed input (uniqueness is enforced by the
 * schema). The one source of truth for "which editors are configured."
 *
 * @example
 * resolveConfiguredIdes({ ide: { provider: 'cursor', config: {...} } }) // => [cursor]
 * resolveConfiguredIdes({ ide: [cursor, zed] })                         // => [cursor, zed]
 * resolveConfiguredIdes({})                                             // => []
 */
export const resolveConfiguredIdes = (config: InfraKitConfig): ConfiguredIde[] => {
  const ide = config.ide

  if (!ide) return []

  return Array.isArray(ide) ? ide : [ide]
}

export interface InfraKitConfigPaths {
  /** Committed project config (required). */
  main: string
  /** User-scope global overrides applied to every project. */
  userGlobal: string
  /** User-scope per-project overrides — `<userProjectsDir>/<projectName>/infra-kit.json`. */
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
 * //   main:        '/Users/arthur/projects/api/infra-kit.json',
 * //   userGlobal:  '/Users/arthur/.infra-kit/config.json',
 * //   userProject: '/Users/arthur/.infra-kit/projects/api/infra-kit.json',
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
 * Read and validate `infra-kit.json`, with optional override layers shallow-merged
 * on top in this order (later wins):
 *   1. project `infra-kit.json`                            — committed source of truth
 *   2. `~/.infra-kit/config.json`                          — user-global defaults
 *   3. `~/.infra-kit/projects/<repo-name>/infra-kit.json`  — user-scope per-project overrides
 *
 * Top-level keys (entire capability sections like `ide`, `envManagement`)
 * replace wholesale. Results are cached per file mtimes so the long-running
 * MCP server picks up edits without a restart.
 *
 * @example
 * // infra-kit.json:           { "environments": ["dev"], "envManagement": { "provider": "doppler", "config": { "name": "p" } } }
 * // ~/.infra-kit/config.json: { "ide": { "provider": "cursor", "config": { "workspaceConfigPath": "./ws.code-workspace" } } }
 * const cfg = await getInfraKitConfig()
 * // => { environments: ['dev'], envManagement: {...}, ide: { provider: 'cursor', config: { workspaceConfigPath: './ws.code-workspace' } } }
 */
export const getInfraKitConfig = async (): Promise<InfraKitConfig> => {
  const paths = await getInfraKitConfigPaths()

  let mainStat: Awaited<ReturnType<typeof fs.stat>>

  try {
    mainStat = await fs.stat(paths.main)
  } catch {
    cached = null

    // Bridge the YAML→JSON cutover: if a legacy infra-kit.yml is sitting where
    // the JSON config should be, point the user at the one-shot migration.
    const legacyYmlPath = paths.main.replace(/\.json$/, '.yml')

    if (await statIfExists(legacyYmlPath)) {
      throw new Error(
        `infra-kit.json not found at ${paths.main}. A legacy infra-kit.yml exists — run \`infra-kit init\` to convert it.`,
      )
    }

    throw new Error(`infra-kit.json not found at ${paths.main}`)
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
    { label: 'infra-kit.json', path: paths.main, required: true },
    { label: '~/.infra-kit/config.json', path: paths.userGlobal, required: false },
    {
      label: `~/.infra-kit/projects/${paths.projectName}/infra-kit.json`,
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
 * const raw = await readIfExists('/missing.json') // => null
 * const raw = await readIfExists('/exists.json')  // => '{ "environments": ["dev"] }\n'
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
 * Read a single layer of the merge chain: parse the JSON if the file exists
 * and validate it against the override schema. Returns `null` if an optional
 * layer is missing; throws if the layer is required, malformed, or invalid.
 * An empty/whitespace-only file is treated as `{}` (JSON.parse would throw).
 *
 * @example
 * await loadLayer({ label: '~/.infra-kit/config.json', path: '/missing.json', required: false })
 * // => null
 *
 * @example
 * // /home/me/.infra-kit/config.json: '{ "ide": { "provider": "cursor", "config": { "workspaceConfigPath": "./ws.code-workspace" } } }'
 * await loadLayer({ label: '~/.infra-kit/config.json', path: '/home/me/.infra-kit/config.json', required: false })
 * // => { ide: { provider: 'cursor', config: { workspaceConfigPath: './ws.code-workspace' } } }
 */
const loadLayer = async (layer: ConfigLayer): Promise<Record<string, unknown> | null> => {
  const raw = await readIfExists(layer.path)

  if (raw === null) {
    if (layer.required) {
      throw new Error(`${layer.label} not found at ${layer.path}`)
    }

    return null
  }

  let parsedRaw: unknown

  try {
    parsedRaw = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON in ${layer.label} at ${layer.path}: ${(err as Error).message}`)
  }

  const result = infraKitOverrideConfigSchema.safeParse(parsedRaw)

  if (!result.success) {
    throw new Error(`Invalid ${layer.label} at ${layer.path}: ${z.prettifyError(result.error)}`)
  }

  return result.data as Record<string, unknown>
}
