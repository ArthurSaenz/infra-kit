// DEFAULT import, deliberately: the module is used as `fs.writeFile(...)` / `fs.mkdir(...)` so every
// call is a property lookup on the live module object, which is what `vi.spyOn(fs, 'writeFile')`
// patches. A named import (`import { writeFile }`) is bound at import time and the spy silently does
// NOT intercept it — verified empirically (default form: spy sees 1 call; named form: spy sees 0
// calls AND the real write still happens). The "0 writes in steady state" tests would then be false
// greens while the seed churned the disk on every command. Do not "modernize" this import.
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { CONFIG_STUB, buildUserProjectExample } from 'src/lib/config-templates'
import { getInfraKitConfigPaths, resetMergedConfigCache } from 'src/lib/infra-kit-config'
import type { InfraKitConfigPaths } from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { fileExists, tildify } from 'src/lib/path-display'

export interface SeedUserProjectResult {
  configPath: string
  examplePath: string
  createdConfig: boolean
  refreshedExample: boolean
}

/**
 * Once-per-process guard for {@link ensureUserProjectConfig}. The MCP server is long-lived and
 * handles N tool calls in one process — without this it would re-stat the config on every call.
 */
let seeded = false

/**
 * Derive the non-loaded `.example.jsonc` sibling for a config path. The config loader only globs the
 * three exact `infra-kit.json` filenames, so the sibling never enters the merge chain.
 *
 * @example
 * exampleSiblingPath('/u/.infra-kit/projects/api/infra-kit.json')
 * // => '/u/.infra-kit/projects/api/infra-kit.example.jsonc'
 */
const exampleSiblingPath = (jsonPath: string): string => {
  return jsonPath.replace(/\.json$/, '.example.jsonc')
}

/**
 * Read a file, degrading a missing/unreadable file to `null` so callers can content-compare without
 * branching on ENOENT.
 *
 * @example
 * await readFileOrNull('/nope.jsonc') // => null
 */
const readFileOrNull = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Create the layer-3 user-project override file (`~/.infra-kit/projects/<repo>/infra-kit.json`) and
 * keep its annotated `.example.jsonc` sibling in sync with the current schema.
 *
 * UNGATED and MAY THROW — this is the primitive, shared by `config edit` and by the entry-boundary
 * wrapper {@link ensureUserProjectConfig}. It deliberately does NOT honour `INFRA_KIT_NO_SEED`
 * (that kill switch guards the wrapper only) and does NOT check for a committed project config.
 *
 * An existing `infra-kit.json` is NEVER touched — user bytes are sacred. The example is rewritten
 * only when its content differs (content compare, not mtime), so the steady state performs zero
 * writes. The MERGED config cache is reset only when the `.json` was actually created: the `.jsonc`
 * example is not part of the merge chain, so refreshing it invalidates nothing. The path memo is
 * left alone either way — see {@link resetMergedConfigCache}.
 *
 * @example
 * const paths = await getInfraKitConfigPaths()
 * await seedUserProjectConfig(paths)
 * // => { configPath: '/u/.infra-kit/projects/api/infra-kit.json',
 * //      examplePath: '/u/.infra-kit/projects/api/infra-kit.example.jsonc',
 * //      createdConfig: true, refreshedExample: true }
 */
export const seedUserProjectConfig = async (paths: InfraKitConfigPaths): Promise<SeedUserProjectResult> => {
  const configPath = paths.userProject
  const examplePath = exampleSiblingPath(configPath)

  await fs.mkdir(path.dirname(configPath), { recursive: true })

  const createdConfig = !(await fileExists(configPath))

  if (createdConfig) {
    // JSON can't carry comments, so seed an empty-but-valid config and drop the annotated guidance
    // next to it in a non-loaded .example.jsonc.
    await fs.writeFile(configPath, CONFIG_STUB, 'utf-8')
  }

  const example = buildUserProjectExample(paths.projectName)
  const refreshedExample = (await readFileOrNull(examplePath)) !== example

  if (refreshedExample) {
    await fs.writeFile(examplePath, example, 'utf-8')
  }

  if (createdConfig) {
    // Only the .json is a real merge layer — never invalidate the cache for a .jsonc-only refresh.
    // MERGED cache only: the new layer changes the merge result, but the resolved paths are a pure
    // function of cwd + homedir, so dropping the path memo here would re-spawn both `git rev-parse`
    // calls on the one run that creates the file.
    resetMergedConfigCache()
  }

  return { configPath, examplePath, createdConfig, refreshedExample }
}

/**
 * The one INFO line announcing a freshly created layer-3 config. Shared by all three seed call sites
 * (the entry-boundary bootstrap below, `config edit`, and `init`) — they announce the same event and
 * must not drift into three wordings.
 *
 * @example
 * seedCreatedMessage(result)
 * // => 'Created ~/.infra-kit/projects/api/infra-kit.json — see ~/.infra-kit/projects/api/infra-kit.example.jsonc for the annotated reference.'
 */
export const seedCreatedMessage = (result: SeedUserProjectResult): string => {
  return `Created ${tildify(result.configPath)} — see ${tildify(result.examplePath)} for the annotated reference.`
}

/**
 * Entry-boundary bootstrap: gate, seed, swallow. NEVER throws and NEVER changes the exit code, so it
 * is safe to await from a CLI preAction hook or an MCP tool-call boundary.
 *
 * Order: the `INFRA_KIT_NO_SEED` kill switch (truthiness, so `vi.stubEnv(…, '')` disarms it), the
 * once-per-process guard, path resolution (throws outside a git repo → silent no-op), then the D2
 * gate — no committed `<repo-root>/infra-kit.json` means this is not an infra-kit project, so
 * nothing is ever created under `~/.infra-kit/projects/` for it.
 *
 * Any seed failure (EACCES / EROFS / ENOSPC / read-only HOME) is `logger.debug`-ed and swallowed.
 * Exactly one `logger.info` line is emitted, and only when the `.json` was actually created; an
 * example-only refresh is `logger.debug` (rewriting a non-loaded reference file is not news).
 * Steady state is completely silent.
 *
 * @example
 * // CLI preAction / MCP tool boundary
 * await ensureUserProjectConfig()
 * // first run in an infra-kit repo — INFO: Created ~/.infra-kit/projects/api/infra-kit.json — …
 * // every later run — silent, zero writes
 */
export const ensureUserProjectConfig = async (): Promise<void> => {
  if (process.env.INFRA_KIT_NO_SEED) {
    return
  }

  if (seeded) {
    return
  }

  seeded = true

  let paths: InfraKitConfigPaths

  try {
    paths = await getInfraKitConfigPaths()
  } catch {
    // Outside a git repo `git rev-parse --show-toplevel` fails. Not an infra-kit project — no-op.
    return
  }

  if (!(await fileExists(paths.main))) {
    return
  }

  try {
    const result = await seedUserProjectConfig(paths)

    if (result.createdConfig) {
      logger.info(seedCreatedMessage(result))
    } else if (result.refreshedExample) {
      logger.debug(`Refreshed ${tildify(result.examplePath)} to match the current schema.`)
    }
  } catch (err) {
    logger.debug({ err, msg: `Skipped seeding ${tildify(paths.userProject)} (config bootstrap failed).` })
  }
}

/**
 * Clear the once-per-process seed guard. Tests only — production seeds exactly once per process.
 *
 * @example
 * resetUserProjectSeedGuard()
 * await ensureUserProjectConfig() // resolves paths again instead of short-circuiting
 */
export const resetUserProjectSeedGuard = (): void => {
  seeded = false
}
