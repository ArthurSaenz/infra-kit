import type { OperationErrorContext } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'

/**
 * Every e2e refusal, in one machine-readable shape: exit 2 (nothing ran) and a `reason` an agent can branch
 * on, instead of an exit 1 whose cause only the stderr prose names.
 */
export const E2E_REFUSAL_REASONS = [
  'protected_env',
  'served_env_mismatch',
  'dead_local_routes',
  'no_dev_server',
  'no_deployed_url_env',
  'env_not_loaded',
  'run_in_progress',
] as const

export type E2eRefusalReason = (typeof E2E_REFUSAL_REASONS)[number]

export const e2eRefusal = (
  reason: E2eRefusalReason,
  details: Record<string, unknown>,
  context: OperationErrorContext,
): StructuredRefusalError => {
  return new StructuredRefusalError({ status: 'refused', reason, ...details }, 2, context)
}
