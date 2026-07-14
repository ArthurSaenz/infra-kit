import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { getMainRepoRoot, getProjectRoot } from 'src/lib/git-utils'

const INFRA_KIT_CONFIG_FILE = 'infra-kit.json'

/**
 * Directory under the user's home that holds all machine-local infra-kit config:
 * the runtime `infra-kit.json` merge layer, per-project overrides, and the factory
 * registry (`vendor.json`). Single source of truth for `.infra-kit`, reused
 * by the vendor factory-config loader (no import cycle — this module imports no
 * `lib/vendor` code).
 */
export const USER_CONFIG_DIR_NAME = '.infra-kit'
const USER_GLOBAL_CONFIG_FILE = 'infra-kit.json'
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

// cmux pane layout for opened worktree workspaces. Named presets keep the config
// typo-proof (an enum, not a free string) and let the opener switch on a single
// value; extend the enum + the opener's switch to add a layout.
//   two-columns — left | right, both full-height (default)
//   three-pane  — left split top/bottom + full-height right (legacy layout)
const cmuxLayouts = ['two-columns', 'three-pane'] as const

const cmuxConfigSchema = z.object({
  layout: z.enum(cmuxLayouts).optional(),
})

// worktrees prompt defaults
const worktreesConfigSchema = z.object({
  openInGithubDesktop: z.boolean().optional(),
  openInCmux: z.boolean().optional(),
  cmux: cmuxConfigSchema.optional(),
})

// dev-server per-app overrides. Maps an app folder name (e.g. `client`) to its
// local dev port and/or URL prefix. Both keys optional. An app absent from the
// map falls back to env (`{APP}_PORT` / `PORT`) then the built-in defaults, so
// the map is intentionally NOT validated against the discovered apps here — an
// unknown app name is simply ignored at resolve time (lib/dev), never a parse
// error that would brick every command.
const devAppConfigSchema = z
  .object({
    port: z.number().int().positive().optional(),
    prefixUrl: z.string().min(1).optional(),
  })
  .strict()

const devConfigSchema = z.record(z.string().min(1), devAppConfigSchema)

// devServersPresets: named local-dev sessions, declared in the per-project infra-kit.json
// (team presets committed; personal ones layered via the user-project override).
// Each preset names launch targets (apps/<app>/{api,ui}), optional per-backend
// `watchDeps`, per-route proxy-source overrides, and a `cmux` layout flag; it is
// consumed by `infra-kit dev <preset>` and resolved by src/dev/presets. Each target key
// names exactly one workspace package (`<app>/api` or `<app>/ui`) — a bare `<app>` is a
// folder, not a package, and is rejected. The SHAPE is strict (typos in a preset surface
// as parse errors), but unknown app/route NAMES are intentionally NOT validated here —
// they resolve at run time against the discovered apps, so a stale preset never bricks
// every command.
const proxySourceSchema = z.enum(['local', 'cloud'])

const devPresetAppSchema = z
  .object({
    // api targets only: watch the backend's dist + shared-package subdeps and restart on change.
    watchDeps: z.boolean().optional(),
    // route path (e.g. `/api`) → source, overriding that route's config.ts default for this session.
    proxy: z.record(z.string().min(1), proxySourceSchema).optional(),
  })
  .strict()

const devPresetSchema = z
  .object({
    // Launch-target key — one package: `client/ui`, `client/api`, `*/api`. Omit `apps` = all.
    apps: z.record(z.string().min(1), devPresetAppSchema).optional(),
    // Run each launched target in its own cmux pane (one workspace, N panes).
    cmux: z.boolean().optional(),
  })
  .strict()

const devPresetsSchema = z.record(z.string().min(1), devPresetSchema)

// DEPRECATED (accepted and ignored). Layer-B local-dev proxy (portless).
//
// The proxy port is no longer negotiable: every dev URL is `https://<release>.<packageName>.localhost`
// with NO port, and the only port that can serve a port-free HTTPS URL is 443. A configurable port would
// put the port straight back into the URL — the exact thing this design removes.
//
// The key is still PARSED so it does not brick anything: `infraKitConfigObject` is `.strict()` and
// `getInfraKitConfig` THROWS on an unknown key, so simply deleting it would hard-fail EVERY infra-kit
// command (not just `dev`) on any machine whose config still carries it — arriving unannounced, because
// the CLI self-updates. It is read by nothing and silently ignored. Remove one release from now.
const devProxyConfigSchema = z
  .object({
    port: z.number().int().positive().optional(),
  })
  .strict()

// env auto-load: opt-in convenience that primes Doppler env when you work inside
// this project / a worktree. Absent => disabled. `trigger` selects the moment
// (pick one):
//   shell-startup  — when a new shell opens inside the project
//   cli-invocation — before each `infra-kit` command (primes SUBSEQUENT commands)
// `config` names which environment to load. It is intentionally NOT validated
// against `environments` here: an invalid name must DISABLE the feature at
// resolve time (lib/env-autoload), never throw inside the merged-config parse and
// brick every command.
const envAutoLoadSchema = z
  .object({
    trigger: z.enum(['shell-startup', 'cli-invocation']),
    config: z.string().min(1),
  })
  .strict()

// Base object shape, kept separate so `.partial()` (which only works on a plain
// ZodObject, not the `.superRefine`-wrapped full schema) can derive the override
// schema from it.
//
// `.strict()` for the same reason every leaf schema below is: this is the one config file humans
// hand-edit, and a non-strict top level silently swallows the typo that matters most. `devServersPreset`
// (missing `s`) or `dev-proxy` would parse clean and turn the feature off with no message. The `dev` and
// `devServersPresets` values stay open `z.record`s — app and preset NAMES are user-chosen — so strictness
// applies to the key set, not the contents.
// GONE: `environments`. It answered three questions at once and was therefore wrong for two of them.
// Where can I deploy? → each workflow's own `workflow_dispatch` `environment.options`, which GitHub
// validates server-side (`lib/workflow-envs`). What can I authenticate to? → the token store
// (`lib/env-tokens`). Being a third, hand-maintained copy of both, it drifted from both: hulyo declared
// 6 envs while every hulyo workflow declared 8, and the client-side check turned that drift into a
// REFUSAL to deploy to `stage` and `prod`.
//
// Deleted outright rather than accepted-and-ignored: the key is removed from every repo in the same
// change, so nothing that is checked out on a current branch still carries it. Because this schema is
// `.strict()`, a config that DOES still carry it (an old release branch, an unmigrated worktree) is
// refused with `Unrecognized key: "environments"` — delete the key there too.
export const infraKitConfigObject = z
  .object({
    envManagement: envManagementSchema,
    ide: idesSchema.optional(),
    taskManager: taskManagerSchema.optional(),
    worktrees: worktreesConfigSchema.optional(),
    envAutoLoad: envAutoLoadSchema.optional(),
    dev: devConfigSchema.optional(),
    devServersPresets: devPresetsSchema.optional(),
    devProxy: devProxyConfigSchema.optional(),
  })
  .strict()

/**
 * The portless proxy's listen port. `443` — the implicit HTTPS port — because that is the ONLY port that
 * can serve a port-free `https://<release>.<packageName>.localhost` URL, which is the whole point.
 *
 * It is privileged, so the daemon must already be running: `infra-kit dev` PROBES it and never elevates
 * (portless binds `:443` by re-execing through `sudo` with an inherited stdio, which a detached child can
 * never answer). One-time, out-of-band: a root `portless service install`, which `dev` and `doctor` print
 * for the user as an absolute-path command (portless is not on `PATH`; see `formatPortlessCommand`). There
 * is deliberately no unprivileged fallback — a fallback puts the port back in the URL.
 *
 * Not a constant of convenience: it is the single value that decides the scheme, and TLS on 443 is
 * portless's own default (our previous `--no-tls` was the deviation).
 */
export const DEFAULT_DEV_PROXY_PORT = 443

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

/** Resolved env auto-load config (`{ trigger, config }`), or `undefined` when off. */
export type EnvAutoLoadConfig = z.infer<typeof envAutoLoadSchema>

/** Per-app dev-server overrides (`{ port?, prefixUrl? }`). */
export type DevAppConfig = z.infer<typeof devAppConfigSchema>

/** The full `dev` section: a map of app folder name to its {@link DevAppConfig}. */
export type DevConfig = z.infer<typeof devConfigSchema>

/** A proxy route's resolved source in a preset override (`'local' | 'cloud'`). */
export type ProxySource = z.infer<typeof proxySourceSchema>

/** A single dev preset (`{ apps?, cmux? }`) from the `devServersPresets` map. */
export type DevPreset = z.infer<typeof devPresetSchema>

/** The `devServersPresets` map: preset name → {@link DevPreset}. */
export type DevPresets = z.infer<typeof devPresetsSchema>

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

/** A cmux pane layout preset (see {@link cmuxLayouts}). */
export type CmuxLayout = (typeof cmuxLayouts)[number]

/** The layout applied when `worktrees.cmux.layout` is left unset. */
export const DEFAULT_CMUX_LAYOUT: CmuxLayout = 'two-columns'

/**
 * Resolve the cmux pane layout for opened worktree workspaces, falling back to
 * {@link DEFAULT_CMUX_LAYOUT} when unconfigured. The one source of truth for
 * "which layout should the cmux opener build."
 *
 * @example
 * resolveCmuxLayout({ worktrees: { cmux: { layout: 'three-pane' } } }) // => 'three-pane'
 * resolveCmuxLayout({})                                                // => 'two-columns'
 */
export const resolveCmuxLayout = (config: InfraKitConfig): CmuxLayout => {
  return config.worktrees?.cmux?.layout ?? DEFAULT_CMUX_LAYOUT
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

interface PathsCacheEntry {
  key: string
  value: InfraKitConfigPaths
}

/**
 * Memo slot for {@link getInfraKitConfigPaths}. SINGLE-ENTRY, not a `Map`: the resolver's only
 * inputs are `process.cwd()` and `os.homedir()`, and production never mutates either (there is zero
 * `process.chdir` outside tests), so one key covers the whole process lifetime. A `Map` would buy
 * nothing there and could hand a chdir'ing test file a stale sibling entry; a single slot that
 * recomputes on key mismatch is strictly safer and identically fast.
 */
let cachedPaths: PathsCacheEntry | null = null

/**
 * Cache key for {@link cachedPaths}. `homedir` is load-bearing, not decoration: the resolver reads
 * it directly, and a dozen test files swap it for a fresh `mkdtemp` home WITHOUT chdir'ing — a
 * cwd-only key would hand test B test A's already-deleted temp home.
 *
 * @example
 * pathsCacheKey() // => '/Users/arthur/projects/api /Users/arthur'
 */
const pathsCacheKey = (): string => {
  return `${process.cwd()} ${os.homedir()}`
}

/**
 * Resolve every file path that participates in the config merge chain. Always
 * returns paths even for files that don't yet exist, so callers can use them
 * for "where would my override go?" prompts.
 *
 * Memoized on `cwd + homedir` (see {@link cachedPaths}) because the two `git rev-parse` spawns below
 * run BEFORE the mtime cache in `getInfraKitConfig`, so without this every call paid for both. The
 * memo is populated on success only — `getProjectRoot` rejects outside a git repo and callers depend
 * on that rejection, so a cached rejection would be a stateful negative path. Cleared by
 * {@link resetInfraKitConfigCache}.
 *
 * Safe to memoize: this is a pure path resolver (inputs = cwd + homedir; it returns paths, never
 * file contents), so filesystem mutation cannot invalidate it.
 *
 * @example
 * const paths = await getInfraKitConfigPaths()
 * // {
 * //   main:        '/Users/arthur/projects/api/infra-kit.json',
 * //   userGlobal:  '/Users/arthur/.infra-kit/infra-kit.json',
 * //   userProject: '/Users/arthur/.infra-kit/projects/api/infra-kit.json',
 * //   projectName: 'api',
 * // }
 */
export const getInfraKitConfigPaths = async (): Promise<InfraKitConfigPaths> => {
  const key = pathsCacheKey()

  if (cachedPaths && cachedPaths.key === key) {
    return cachedPaths.value
  }

  const projectRoot = await getProjectRoot()
  // Namespace the per-project override on the MAIN repo root, not `projectRoot`.
  // Inside a linked worktree `projectRoot` is the worktree's own path, so its
  // basename is the worktree's leaf dir (e.g. `feature-x`), which would key the
  // override to a different, per-worktree file. `getMainRepoRoot` resolves the
  // shared git common dir so every worktree of a repo converges on one key. The
  // second `git rev-parse` this costs is fine — the merged config is mtime-cached.
  const mainRepoRoot = await getMainRepoRoot(projectRoot)
  const projectName = path.basename(mainRepoRoot)
  const userConfigDir = path.join(os.homedir(), USER_CONFIG_DIR_NAME)

  const value: InfraKitConfigPaths = {
    main: path.join(projectRoot, INFRA_KIT_CONFIG_FILE),
    userGlobal: path.join(userConfigDir, USER_GLOBAL_CONFIG_FILE),
    userProject: path.join(userConfigDir, USER_PROJECTS_DIR, projectName, INFRA_KIT_CONFIG_FILE),
    projectName,
  }

  // Populate only after both git calls RESOLVED — never cache a rejection.
  cachedPaths = { key, value }

  return value
}

/**
 * Read and validate `infra-kit.json`, with optional override layers shallow-merged
 * on top in this order (later wins):
 *   1. project `infra-kit.json`                            — committed source of truth
 *   2. `~/.infra-kit/infra-kit.json`                       — user-global defaults
 *   3. `~/.infra-kit/projects/<repo-name>/infra-kit.json`  — user-scope per-project overrides
 *
 * Top-level keys (entire capability sections like `ide`, `envManagement`)
 * replace wholesale. Results are cached per file mtimes so the long-running
 * MCP server picks up edits without a restart.
 *
 * @example
 * // infra-kit.json:           { "environments": ["dev"], "envManagement": { "provider": "doppler", "config": { "name": "p" } } }
 * // ~/.infra-kit/infra-kit.json: { "ide": { "provider": "cursor", "config": { "workspaceConfigPath": "./ws.code-workspace" } } }
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
    { label: '~/.infra-kit/infra-kit.json', path: paths.userGlobal, required: false },
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
 * Drop ONLY the merged-config cache ({@link cached}), keeping the path memo ({@link cachedPaths})
 * intact. For writers of a merge layer — the config bootstrap, which creates the layer-3
 * `~/.infra-kit/projects/<repo>/infra-kit.json`.
 *
 * WHY this exists separately from {@link resetInfraKitConfigCache}: writing the layer-3 file changes
 * the MERGE RESULT (a stale merged config would miss the new layer) but it cannot change the
 * RESOLVED PATHS — those are a pure function of `cwd + homedir`, and creating a file mutates
 * neither. Blowing away the path memo there would just make the very run that creates the file
 * re-spawn both `git rev-parse` processes for nothing: 4 spawns instead of 2.
 *
 * @example
 * await fs.writeFile(paths.userProject, '{}\n', 'utf-8')
 * resetMergedConfigCache()
 * await getInfraKitConfig()      // sees the new layer-3 layer
 * await getInfraKitConfigPaths() // still served from the memo — zero extra git spawns
 */
export const resetMergedConfigCache = (): void => {
  cached = null
}

/**
 * For tests — drops BOTH in-memory caches: the mtime-fingerprinted merged config and the
 * `cwd + homedir`-keyed path memo ({@link cachedPaths}). The next read re-spawns `git rev-parse`
 * and re-hits disk. Production writers want the narrower {@link resetMergedConfigCache}.
 *
 * @example
 * resetInfraKitConfigCache()
 * await getInfraKitConfig() // re-resolves paths and re-reads files even if mtimes look unchanged
 */
export const resetInfraKitConfigCache = (): void => {
  cached = null
  cachedPaths = null
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
 * await loadLayer({ label: '~/.infra-kit/infra-kit.json', path: '/missing.json', required: false })
 * // => null
 *
 * @example
 * // /home/me/.infra-kit/infra-kit.json: '{ "ide": { "provider": "cursor", "config": { "workspaceConfigPath": "./ws.code-workspace" } } }'
 * await loadLayer({ label: '~/.infra-kit/infra-kit.json', path: '/home/me/.infra-kit/infra-kit.json', required: false })
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

  // `envTokens` is ALREADY rejected below — the override schema keeps `.strict()`, so it lands as a
  // generic `unrecognized_keys` issue. That generic message is wrong for this one key: the user has
  // pasted a live Doppler service token into a file that may be committed, backed up by their editor,
  // or opened by `config edit`. The first instruction has to be REVOKE, not "fix your config". Narrow
  // by construction — every other unknown key keeps the generic error.
  if (isRecord(parsedRaw) && 'envTokens' in parsedRaw) {
    throw new Error(buildEnvTokensRejectionMessage(layer))
  }

  const result = infraKitOverrideConfigSchema.safeParse(parsedRaw)

  if (!result.success) {
    throw new Error(`Invalid ${layer.label} at ${layer.path}: ${z.prettifyError(result.error)}`)
  }

  return result.data as Record<string, unknown>
}

/**
 * Narrow parsed JSON to a plain object so a key probe is safe (JSON's top level may be an array, a
 * string, or `null`).
 *
 * @example
 * isRecord({ envTokens: {} }) // => true
 * isRecord(['envTokens'])     // => false
 * isRecord(null)              // => false
 */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The REVOKE-first refusal for a service token found in an `infra-kit.json`. Ordered by urgency: the
 * credential is already exposed, so revoking it beats editing the file. Tokens live in a SIBLING
 * `tokens.json` (0600) that this loader never reads — see `lib/env-tokens`.
 *
 * @example
 * buildEnvTokensRejectionMessage({ label: 'infra-kit.json', path: '/r/infra-kit.json', required: true })
 * // => 'Refusing to load infra-kit.json — `envTokens` is not a config key. …'
 */
const buildEnvTokensRejectionMessage = (layer: ConfigLayer): string => {
  return [
    `Refusing to load ${layer.label} — \`envTokens\` is not a config key.`,
    'A service token in a config file can be committed, backed up by your editor, or shared.',
    '  1. REVOKE the token in Doppler now — treat it as compromised.',
    `  2. Remove the \`envTokens\` key from ${layer.path}.`,
    '  3. Re-add it privately: `infra-kit env-token-set <env>`',
    '     (it is written to ~/.infra-kit/projects/<repo>/tokens.json, mode 0600, never to the repo).',
  ].join('\n')
}
