import { z } from 'zod'

import { agentMode, isHeadless } from 'src/lib/agent-mode'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { logger } from 'src/lib/logger'
import type { ArgumentFormProvider } from 'src/types'

/**
 * @fileoverview
 * The form-backed twin of `resolveHeadless`: where a human would be shown the command's picker, an
 * agent (or a `--json` run) is refused with `argument_required` AND `choices` — the form's requested
 * schema rendered as JSON Schema, i.e. exactly the rows the `src/lib/*-form/` builders already
 * produce. No command invents a row shape of its own; the skill turns `choices` into a question and
 * re-runs with the pick.
 *
 * Runs at the TOP of the six form-backed handlers, before their pickers, because a picker only knows
 * its own field while the provider knows every field round 1 omitted (`deploy-selected` can be
 * missing `version`, `env` and `services` at once — one refusal lists all three).
 */

export interface RefuseMissingArgumentsInput {
  provider: ArgumentFormProvider
  /** The handler's arguments as received — what `isFormable` and `buildRequestedSchema` inspect. */
  params: unknown
  operation: string
  /**
   * The CLI flag to name — a string when one flag answers the whole form (`release-create`'s four
   * fields all fold into `--release <spec>`), or a function of the form's fields that `params` left
   * EMPTY, for the tools whose flags mirror their fields (`deploy-selected` names `env` when
   * `version` was given, although the form re-offers `version` too). The function sees `[]` when
   * the builder had nothing to offer.
   */
  argument: string | ((missing: string[]) => string)
}

/** The provider contract says never-throw; a programming error inside it must not become a crash here. */
const requestedSchema = async (input: RefuseMissingArgumentsInput): Promise<z.ZodObject<z.ZodRawShape> | null> => {
  try {
    return await input.provider.buildRequestedSchema(input.params)
  } catch (error) {
    logger.debug({ err: error, operation: input.operation }, 'argument form builder threw; refusing without choices')

    return null
  }
}

/**
 * Refuse, naming the first argument the form would have asked for and carrying the whole form as
 * `choices`, when an agent / `--json` run omitted a picker argument. A no-op for a human at a TTY
 * and when the provider says the arguments are already complete.
 *
 * @example
 * await refuseMissingArguments({ provider, params: args, operation: 'env-load', argument: 'config' })
 * // agent, `config` omitted → throws { status: 'argument_required', argument: 'config', choices: {...} }
 */
export const refuseMissingArguments = async (input: RefuseMissingArgumentsInput): Promise<void> => {
  if (!isHeadless() || !input.provider.isFormable(input.params)) return

  const schema = await requestedSchema(input)
  const params =
    typeof input.params === 'object' && input.params !== null ? (input.params as Record<string, unknown>) : {}
  // A form may re-offer a field round 1 already carried (the deploy form keeps `version` editable);
  // the flag named is the first one the caller actually left out.
  const missing = (schema === null ? [] : Object.keys(schema.shape)).filter((field) => {
    return params[field] === undefined || params[field] === ''
  })
  const argument = typeof input.argument === 'string' ? input.argument : input.argument(missing)
  const choices = schema === null ? undefined : z.toJSONSchema(schema)

  throw new StructuredRefusalError(
    {
      status: 'argument_required',
      argument,
      ...(choices === undefined ? {} : { choices }),
      agentMode: agentMode.source,
    },
    2,
    {
      operation: input.operation,
      remediation:
        choices === undefined
          ? `pass --${argument} on the re-run — nothing could be listed to choose from`
          : `ask the human to pick from "choices", then pass --${argument} on the re-run`,
      stderrExcerpt: `--${argument} was not given and there is no human to ask`,
    },
  )
}
