import { SCOPE_LABELS, assertConfigKey, editConfigLayer, parseConfigValue } from 'src/lib/config-layer'
import type { ConfigScope } from 'src/lib/config-layer'
import { logger } from 'src/lib/logger'
import { tildify } from 'src/lib/path-display'
import { textContent } from 'src/types'

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
