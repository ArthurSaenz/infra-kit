import select from '@inquirer/select'

import { OperationError } from 'src/lib/errors/operation-error'

import { withEscape } from './escapable-context'

/**
 * Ask which environment to deploy to, given the options the target workflow declares.
 *
 * `options` may legitimately be empty: the repo may have no such workflow (bridge has none), the
 * `environment` input may be free-text (`type: string`) rather than a `choice`, or the YAML may not
 * parse. None of those is a broken repo, so none of them may kill the command — but there is also
 * nothing to put in a picker, so this asks for `--env` by name instead of showing an empty menu.
 *
 * Note what this does NOT do: it never rejects an env for being absent from `options`. The list is read
 * from the WORKING TREE while the dispatch targets `--ref <branch>`, so the two can legitimately differ,
 * and GitHub validates the `choice` server-side regardless. Vetoing on a local read of a remote fact is
 * what made `stage` and `prod` undeployable under the old `environments` array.
 *
 * @example
 * await pickEnv(['dev', 'stage'], 'launch deploy-all workflow') // => select prompt
 * await pickEnv([], 'launch deploy-all workflow')               // => throws, naming --env
 */
export const pickEnv = async (options: string[], operation: string): Promise<string> => {
  if (options.length === 0) {
    throw new OperationError(undefined, {
      operation,
      remediation: 'pass --env <name> explicitly',
      stderrExcerpt: 'the workflow declares no `environment` choices to pick from',
    })
  }

  return withEscape((context) => {
    return select(
      {
        message: '🧪 Select environment',
        choices: options.map((option) => {
          return {
            name: option,
            value: option,
          }
        }),
      },
      context,
    )
  })
}
