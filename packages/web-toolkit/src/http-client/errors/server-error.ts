// import type { EManagedError } from '@pkg/lib-data'

/**
 * @see https://engineering.udacity.com/handling-errors-like-a-pro-in-typescript-d7a314ad4991
 */
export class ErrorBase<T extends string> extends Error {
  type: T
  message: string
  extraData?: any
  metaData?: any
  cause?: any

  constructor(args: { type: T; message: string; cause?: any; extraData?: any; metaData?: any }) {
    super()

    const { type, message, cause, extraData, metaData } = args

    // if (Error.captureStackTrace) {
    //   Error.captureStackTrace(this, ErrorBase)
    // }

    this.type = type
    this.message = message
    this.cause = cause
    this.extraData = extraData
    this.metaData = metaData
  }
}

// export class ServerError extends ErrorBase<EManagedError> {}
/**
 * Server error class when we receive status 570 from the server
 */
export class ServerError<R extends string> extends ErrorBase<R> {}
