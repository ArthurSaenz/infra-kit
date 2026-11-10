import { quietShell } from 'src/lib/quiet-shell'

import type { CheckResult } from '../check-result'

export const checkCommand = async (
  name: string,
  command: string[],
  successMsg: string,
  failMsg: string,
): Promise<CheckResult> => {
  try {
    await quietShell()`${command}`

    return { name, status: 'pass', message: successMsg }
  } catch {
    return { name, status: 'fail', message: failMsg }
  }
}
