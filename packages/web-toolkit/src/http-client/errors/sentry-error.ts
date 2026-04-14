// import * as Sentry from '@sentry/react'

// /**
//  * @deprecated
//  */
// export class SentryError extends Error {
//   constructor(
//     errorMessage: string,
//     data?: Record<string, unknown>,
//     tags?: Record<string, string | boolean | number>,
//     type = 'error',
//     options?: { unhandled: boolean },
//   ) {
//     // Passes errMessage to the Error super class,
//     // similar to call new Error(errMessage).
//     super(errorMessage)

//     if (Error.captureStackTrace) {
//       Error.captureStackTrace(this, SentryError)
//     }

//     // Name for all controlled exception in application
//     this.name = 'SentryError'

//     // this.data = data || {}

//     Sentry.addBreadcrumb({
//       category: 'data',
//       message: errorMessage,
//       data,
//       type,
//       level: 'debug',
//     })

//     if (!options?.unhandled) {
//       Sentry.captureException(errorMessage, tags ? { tags } : undefined)
//     }
//   }
// }
export {}
