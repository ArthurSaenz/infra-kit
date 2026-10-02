import fs from 'node:fs/promises'
import path from 'node:path'

import { agentMode, isAgentMode } from 'src/lib/agent-mode'
import { atomicWriteFileSync } from 'src/lib/constants'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import {
  getInfraKitConfig,
  getInfraKitConfigPaths,
  infraKitConfigObject,
  resetMergedConfigCache,
} from 'src/lib/infra-kit-config'
import { logger } from 'src/lib/logger'
import { tildify } from 'src/lib/path-display'
import { textContent } from 'src/types'

/** Which per-machine layer a write lands in. The committed project `infra-kit.json` is never one. */
export type ConfigScope = 'project' | 'global'

// A function, not a module-level constant: the command catalog imports this module, and suites that
// mock the config loader would otherwise need `infraKitConfigObject` in every mock just to load.
export const configKeys = (): string[] => {
  return Object.keys(infraKitConfigObject.shape)
}

/**
 * `protectedEnvs: "cli-only"` exists to keep an agent away from the delivery-shaped envs; an agent
 * that could rewrite it would hold the key to its own gate.
 */
const HUMAN_ONLY_KEYS: ReadonlySet<string> = new Set(['protectedEnvs'])

export const SCOPE_LABELS: Record<ConfigScope, string> = {
  project: 'per-project override',
  global: 'user-global override',
}

/**
 * Refuse anything but a top-level schema key. Layers merge per TOP-LEVEL key (shallow), so a write of
 * `dev.port` would land as `{ dev: { port } }` and replace the project's whole `dev` section.
 *
 * @example
 * assertConfigKey('ide')      // ok
 * assertConfigKey('dev.port') // throws, naming the shallow merge
 */
export const assertConfigKey = (key: string, operation: string): void => {
  if (isAgentMode() && HUMAN_ONLY_KEYS.has(key)) {
    throw new StructuredRefusalError({ status: 'refused', agentMode: agentMode.source }, 2, {
      operation,
      remediation: `ask the human to run \`infra-kit ${operation} ${key} …\` in their own terminal`,
      stderrExcerpt: `"${key}" decides what an agent may reach, so an agent may not change it`,
    })
  }

  if (configKeys().includes(key)) return

  if (key.includes('.')) {
    const section = key.split('.')[0] ?? key

    throw new Error(
      `Nested keys are not supported: override layers merge per top-level key, so "${key}" would replace the whole "${section}" section. Set "${section}" to its full JSON value instead, or use \`infra-kit config edit\`.`,
    )
  }

  throw new Error(`Unknown config key "${key}". Top-level keys: ${configKeys().join(', ')}.`)
}

/**
 * A value is JSON when it parses as JSON, and a bare string otherwise — so `allow` needs no quoting
 * while `'[{"provider":"orca"}]'` still arrives as an array.
 *
 * @example
 * parseConfigValue('allow')        // => 'allow'
 * parseConfigValue('{"a":1}')      // => { a: 1 }
 * parseConfigValue('true')         // => true
 */
export const parseConfigValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const readLayer = async (file: string): Promise<{ raw: string | null; data: Record<string, unknown> }> => {
  let raw: string | null

  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return { raw: null, data: {} }
  }

  let parsed: unknown

  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${tildify(file)}: ${(error as Error).message} — fix it with \`infra-kit config edit\`.`,
    )
  }

  if (!isRecord(parsed))
    throw new Error(`${tildify(file)} is not a JSON object — fix it with \`infra-kit config edit\`.`)

  return { raw, data: parsed }
}

const restoreLayer = async (file: string, raw: string | null): Promise<void> => {
  if (raw === null) {
    await fs.rm(file, { force: true })
  } else {
    atomicWriteFileSync(file, raw, 0o644)
  }

  resetMergedConfigCache()
}

export interface LayerEdit {
  file: string
  previous: unknown
  changed: boolean
}

/**
 * Apply one top-level edit to a per-machine layer, then prove it through the REAL loader: the file is
 * written, the merged config is re-read, and any refusal (strict schema, project-only key, a merged
 * invariant) restores the previous bytes before it propagates. Validation by the loader itself rather
 * than a re-implementation, so `config-set` can never accept what every other command would refuse.
 */
export const editConfigLayer = async (
  scope: ConfigScope,
  key: string,
  apply: (data: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<LayerEdit> => {
  const paths = await getInfraKitConfigPaths()
  const file = scope === 'global' ? paths.userGlobal : paths.userProject
  const { raw, data } = await readLayer(file)
  const previous = data[key]
  const next = apply({ ...data })

  if (next === null) return { file, previous, changed: false }

  await fs.mkdir(path.dirname(file), { recursive: true })
  atomicWriteFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 0o644)
  resetMergedConfigCache()

  try {
    await getInfraKitConfig({ autoMigrate: 'off' })
  } catch (error) {
    await restoreLayer(file, raw)

    throw new Error(`${(error as Error).message}\n${tildify(file)} was left unchanged.`)
  }

  return { file, previous, changed: true }
}

export interface ConfigSetArgs {
  key: string
  value: string
  /** Write the user-global layer (`~/.infra-kit/infra-kit.json`) instead of this project's override. */
  global?: boolean
}

/**
 * Set one top-level key in a per-machine override layer — the `gh config set` shape. The committed
 * project `infra-kit.json` is never written: a team-wide change goes through review.
 *
 * @example
 * // CLI: `infra-kit config-set protectedEnvs cli-only`
 * // INFO: Set protectedEnvs = "cli-only" in the per-project override (~/.infra-kit/projects/api/infra-kit.json)
 */
export const configSet = async ({ key, value, global }: ConfigSetArgs) => {
  assertConfigKey(key, 'config-set')

  const scope: ConfigScope = global ? 'global' : 'project'
  const parsed = parseConfigValue(value)

  const { file, previous } = await editConfigLayer(scope, key, (data) => {
    return { ...data, [key]: parsed }
  })

  logger.info(`Set ${key} = ${JSON.stringify(parsed)} in the ${SCOPE_LABELS[scope]} (${tildify(file)})`)

  const structuredContent = { key, value: parsed, previous: previous ?? null, scope, path: file }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}
