import path from 'node:path'

import { DOPPLER_PROJECT_MAP } from 'src/lib/constants'
import { getProjectRoot } from 'src/lib/git-utils'

/**
 * Resolve Doppler project name from the current working directory
 */
export const getDopplerProject = async (): Promise<string> => {
  const projectRoot = await getProjectRoot()

  const dirName = path.basename(projectRoot)
  const dopplerProject = DOPPLER_PROJECT_MAP[dirName]

  if (!dopplerProject) {
    throw new Error(
      `Could not determine Doppler project for directory "${dirName}". ` +
        `Expected one of: ${Object.keys(DOPPLER_PROJECT_MAP).join(', ')}`,
    )
  }

  return dopplerProject
}
