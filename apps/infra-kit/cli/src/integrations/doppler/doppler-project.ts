import { getInfraKitConfig } from 'src/lib/infra-kit-config'

/**
 * Resolve Doppler project name from infra-kit.yml at the project root
 */
export const getDopplerProject = async (): Promise<string> => {
  const { dopplerProjectName } = await getInfraKitConfig()

  return dopplerProjectName
}
