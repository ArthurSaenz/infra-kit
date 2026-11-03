import { z } from 'zod'

import { SCOPE_LABELS, assertConfigKey, editConfigLayer } from 'src/lib/config-layer'
import type { ConfigScope } from 'src/lib/config-layer'
import { logger } from 'src/lib/logger'
import { tildify } from 'src/lib/path-display'
import { textContent } from 'src/types'

export interface ConfigUnsetArgs {
  key: string
  global?: boolean
}

/** `config-unset --json`. */
export const configUnsetOutputSchema = {
  key: z.string(),
  removed: z.boolean(),
  previous: z.unknown().describe('The value the layer held before, or null'),
  scope: z.enum(['project', 'global']),
  path: z.string().describe('The layer file edited'),
}

/**
 * Drop one top-level key from a per-machine override layer, so the layer below shows through again.
 * A key that is not there is the state asked for — a no-op, not an error.
 *
 * @example
 * // CLI: `infra-kit config-unset protectedEnvs`
 * // INFO: Removed protectedEnvs from the per-project override (~/.infra-kit/projects/api/infra-kit.json)
 */
export const configUnset = async ({ key, global }: ConfigUnsetArgs) => {
  assertConfigKey(key, 'config-unset')

  const scope: ConfigScope = global ? 'global' : 'project'

  const { file, previous, changed } = await editConfigLayer(scope, key, (data) => {
    if (!(key in data)) return null

    return Object.fromEntries(
      Object.entries(data).filter(([name]) => {
        return name !== key
      }),
    )
  })

  logger.info(
    changed
      ? `Removed ${key} from the ${SCOPE_LABELS[scope]} (${tildify(file)})`
      : `${key} is not set in the ${SCOPE_LABELS[scope]} (${tildify(file)}) — nothing to remove`,
  )

  const structuredContent: z.infer<z.ZodObject<typeof configUnsetOutputSchema>> = {
    key,
    removed: changed,
    previous: previous ?? null,
    scope,
    path: file,
  }

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}
