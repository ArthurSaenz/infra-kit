import type { OperationError } from 'src/lib/errors/operation-error'

/**
 * Await a call that is expected to reject and hand back the `OperationError` it rejected with.
 *
 * `await promise.catch(err => err)` types as a union with the resolved value, so every assertion
 * on the error needs a cast at the call site. This narrows once, and turns "it resolved" — the
 * failure mode a bare `.catch` swallows into a passing test — into an explicit failure.
 */
export const expectRejection = async (promise: Promise<unknown>): Promise<OperationError> => {
  const error = await promise.then(
    () => {
      return null
    },
    (err: unknown) => {
      return err as OperationError
    },
  )

  if (!error) throw new Error('expected the call to reject, but it resolved')

  return error
}
