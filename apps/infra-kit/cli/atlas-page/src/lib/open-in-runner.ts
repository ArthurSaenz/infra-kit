import { httpPostJson } from './http-client'

const OPEN_URL = '/__atlas/open'

/**
 * Asks the runner to open `openId` (Finder, an Orca tab). `false` covers every way it cannot: no Orca, an
 * older vite plugin that refuses the POST, a runner that is gone — the caller then follows the editor link.
 */
export const openInRunner = async (openId: string, post = httpPostJson): Promise<boolean> => {
  try {
    return (await post(OPEN_URL, { id: openId })).ok
  } catch {
    return false
  }
}
