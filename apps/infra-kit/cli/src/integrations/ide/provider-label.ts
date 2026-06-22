import { assertNever } from 'src/lib/assert-never'

import type { IdeProvider } from './types'

/**
 * Human-facing display name for an IDE provider, used in log lines. Falls back to
 * a generic "IDE" when no provider is configured.
 */
export const ideProviderLabel = (provider: IdeProvider | undefined): string => {
  switch (provider) {
    case 'cursor': {
      return 'Cursor'
    }
    case 'zed': {
      return 'Zed'
    }
    case undefined: {
      return 'IDE'
    }
    default: {
      return assertNever(provider)
    }
  }
}
