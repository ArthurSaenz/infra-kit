import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import { vendorTargetSchema } from 'src/lib/infra-kit-config'
import type { ModuleSelection } from 'src/lib/vendor/sync'

/**
 * The modules a target takes, from the `vendorTarget` block of its own `infra-kit.json`. Read directly, not
 * through the merged loader: that loader is bound to the cwd and may migrate the file on disk, which would
 * dirty a target the sync is about to inspect. A missing file or block means every module.
 *
 * @example
 * readTargetSelection('/Users/me/projects/hulyo') // => { kind: 'modules', modules: ['web-toolkit'] }
 */
export const readTargetSelection = (targetRoot: string): ModuleSelection => {
  let raw: string

  try {
    raw = readFileSync(path.join(targetRoot, 'infra-kit.json'), 'utf8')
  } catch {
    return { kind: 'all' }
  }

  let block: unknown

  try {
    block = (JSON.parse(raw) as { vendorTarget?: unknown } | null)?.vendorTarget
  } catch (error) {
    return { kind: 'invalid', reason: `infra-kit.json is not valid JSON: ${(error as Error).message}` }
  }

  if (block === undefined) return { kind: 'all' }

  const parsed = vendorTargetSchema.safeParse(block)

  if (!parsed.success) return { kind: 'invalid', reason: z.prettifyError(parsed.error) }

  return { kind: 'modules', modules: parsed.data.modules }
}
