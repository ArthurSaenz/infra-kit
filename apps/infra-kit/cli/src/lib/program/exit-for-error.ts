import process from 'node:process'

import { isPromptCancellation } from 'src/lib/errors/is-prompt-cancellation'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { emit } from 'src/lib/json-output'
import { logger } from 'src/lib/logger'

export interface ExitForErrorDeps {
  exit: (code: number) => never
  emit: typeof emit
  logger: Pick<typeof logger, 'info' | 'error'>
}

const DEFAULT_DEPS: ExitForErrorDeps = { exit: process.exit, emit, logger }

/**
 * The top-level catch of `entry/cli.ts`: turn whatever escaped `parseAsync` into a message and an exit
 * code. Three branches, in this order:
 *
 * 1. a prompt cancellation (Ctrl-C / Esc) exits 0 — a deliberate back-out, not a failure;
 * 2. a `StructuredRefusalError` emits its payload (stdout, `--json` only), logs its message and exits
 *    with the error's own code;
 * 3. anything else logs its message and exits 1.
 *
 * Extracted from `entry/cli.ts` — which runs at import time and so cannot be unit-tested — with the
 * process seams injectable. `deps` exist for the test; production callers pass nothing.
 */
export const exitForError = (error: unknown, deps: ExitForErrorDeps = DEFAULT_DEPS): never => {
  if (isPromptCancellation(error)) {
    deps.logger.info('Operation cancelled.')

    return deps.exit(0)
  }

  // `emit` writes only under `jsonOutput.enabled`, so it is called unconditionally: the branch stays
  // one shape whether or not `--json` was given, and a refusal thrown before `preAction` resolved the
  // flag simply emits nothing. The message always reaches stderr.
  if (error instanceof StructuredRefusalError) {
    deps.emit({ structuredContent: error.structuredContent })
    deps.logger.error(error.message)

    return deps.exit(error.exitCode)
  }

  deps.logger.error(error instanceof Error ? error.message : String(error))

  return deps.exit(1)
}
