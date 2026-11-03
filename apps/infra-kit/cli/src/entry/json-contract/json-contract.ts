/**
 * @fileoverview
 *
 * The `--json` contract: one zod schema per command that writes a document, envelope included. The
 * catalog rows' `mcpTool.outputSchema` already type-check their handlers' payloads (see
 * `defineMcpTool`); the commands without a tool export their own shape, listed here. The snapshot in
 * `__tests__/json-contract.test.ts` is the reviewable diff of every change to the contract.
 */
import { z } from 'zod'

import { configEditOutputSchema, configPathOutputSchema } from 'src/commands/config'
import { configSetOutputSchema } from 'src/commands/config-set'
import { configUnsetOutputSchema } from 'src/commands/config-unset'
import { deployRunOutputSchema } from 'src/commands/deploy-run'
import { deploySyncOutputSchema } from 'src/commands/deploy-sync'
import { envTokenRemoveOutputSchema } from 'src/commands/env-token-remove'
import { envTokenSetFromFileOutputSchema, envTokenSetOutputSchema } from 'src/commands/env-token-set'
import { autoSetupOutputSchema, setupMcpTool } from 'src/commands/setup'
import { vendorSyncOutputSchema } from 'src/commands/vendor-sync'
import { jsonEnvelopeShape } from 'src/lib/json-output'

import { commandCatalog } from '../command-catalog'

/** Leaves that never write a `--json` document: `dev` runs a session, `vendor config` returns nothing. */
export const NO_JSON_COMMANDS: readonly string[] = ['dev', 'vendor config']

// A payload key named like an envelope key would be replaced on the wire (the payload spreads last in
// `withEnvelope`), so the contract refuses to describe one.
const enveloped = (shape: z.ZodRawShape) => {
  const collisions = Object.keys(shape).filter((key) => {
    return key in jsonEnvelopeShape
  })

  if (collisions.length > 0) throw new Error(`--json payload key collides with the envelope: ${collisions.join(', ')}`)

  return z.object({ ...jsonEnvelopeShape, ...shape })
}

/** What any command writes instead of its payload when it refuses (`exitForError`). */
export const jsonRefusalSchema = z.looseObject({
  ...jsonEnvelopeShape,
  status: z.enum(['confirmation_required', 'argument_required', 'partial_failure', 'refused']),
})

const EXPLICIT: Record<string, z.ZodType> = {
  'config path': enveloped(configPathOutputSchema),
  'config edit': enveloped(configEditOutputSchema),
  'config-set': enveloped(configSetOutputSchema),
  'config-unset': enveloped(configUnsetOutputSchema),
  'deploy-run': enveloped(deployRunOutputSchema),
  'deploy-sync': enveloped(deploySyncOutputSchema),
  'vendor sync': enveloped(vendorSyncOutputSchema),
  'env-token-remove': enveloped(envTokenRemoveOutputSchema),
  // Two actions behind one leaf: `<env>` stores one token, `--from-file` imports many.
  'env-token-set': z.union([enveloped(envTokenSetOutputSchema), enveloped(envTokenSetFromFileOutputSchema)]),
  // `setup --auto` returns the background run's outcome instead of the converge report.
  setup: z.union([enveloped(setupMcpTool.outputSchema), enveloped(autoSetupOutputSchema)]),
}

/** Every `--json` document by grouped command path (`release create`), envelope included. */
export const jsonOutputSchemas: Readonly<Record<string, z.ZodType>> = {
  ...Object.fromEntries(
    commandCatalog.flatMap((entry) => {
      return entry.mcpTool === null ? [] : [[entry.groupPath.join(' '), enveloped(entry.mcpTool.outputSchema)]]
    }),
  ),
  ...EXPLICIT,
}
