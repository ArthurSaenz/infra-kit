import process from 'node:process'

import { logger } from 'src/lib/logger'

import type {
  CreateJiraVersionParams,
  CreateJiraVersionResult,
  DeliverJiraReleaseParams,
  DeliverJiraReleaseResult,
  JiraConfig,
  JiraVersion,
  UpdateJiraVersionParams,
  UpdateJiraVersionResult,
} from './types.js'

/**
 * Creates a new version in Jira using the REST API
 * @param params - Version creation parameters
 * @param config - Jira configuration (baseUrl, token, projectId)
 * @returns Result containing created version or error
 */
export const createJiraVersion = async (
  params: CreateJiraVersionParams,
  config: JiraConfig,
): Promise<CreateJiraVersionResult> => {
  try {
    const { baseUrl, token, email, projectId } = config

    // Use current date if not provided
    // const releaseDate =
    //   params.releaseDate || new Date().toISOString().split('T')[0] // 2025-12-06

    // Prepare request body
    const requestBody = {
      name: params.name,
      projectId: params.projectId || projectId,
      description: params.description || '',
      //   releaseDate,
      released: params.released || false,
      archived: params.archived || false,
    }

    // logger.info(
    //   { version: params.name, projectId: requestBody.projectId },
    //   'Creating Jira version',
    // )

    // Make API request
    const url = `${baseUrl}/rest/api/3/version`

    // Create Basic auth credentials
    const credentials = btoa(`${email}:${token}`)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()

      logger.error(
        {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
        },
        'Failed to create Jira version',
      )

      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const version = (await response.json()) as JiraVersion

    // logger.info(
    //   { versionId: version.id, versionName: version.name },
    //   'Successfully created Jira version',
    // )

    return {
      success: true,
      version,
    }
  } catch (error) {
    logger.error({ error }, 'Error creating Jira version')

    throw error
  }
}

/**
 * Gets all versions for a project from Jira
 * @param config - Jira configuration
 * @returns Array of JiraVersion objects
 */
export const getProjectVersions = async (config: JiraConfig): Promise<JiraVersion[]> => {
  try {
    const { baseUrl, token, email, projectId } = config

    const url = `${baseUrl}/rest/api/3/project/${projectId}/versions`
    const credentials = btoa(`${email}:${token}`)

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${credentials}`,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()

      logger.error(
        {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
        },
        'Failed to get Jira project versions',
      )

      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const versions = (await response.json()) as JiraVersion[]

    return versions
  } catch (error) {
    logger.error({ error }, 'Error getting Jira project versions')

    throw error
  }
}

/**
 * Finds a Jira version by name in the project
 * @param versionName - Name of the version to find (e.g., "v1.33.10")
 * @param config - Jira configuration
 * @returns JiraVersion if found, null otherwise
 */
const findVersionByName = async (versionName: string, config: JiraConfig): Promise<JiraVersion | null> => {
  try {
    const versions = await getProjectVersions(config)
    const version = versions.find((v) => {
      return v.name === versionName
    })

    return version || null
  } catch (error) {
    logger.error({ error, versionName }, 'Error finding Jira version by name')

    throw error
  }
}

/**
 * Updates an existing Jira version
 * @param params - Update parameters
 * @param config - Jira configuration
 * @returns Result containing updated version or error
 */
const updateJiraVersion = async (
  params: UpdateJiraVersionParams,
  config: JiraConfig,
): Promise<UpdateJiraVersionResult> => {
  try {
    const { baseUrl, token, email } = config

    // Prepare request body - only include fields that are provided
    const requestBody: Record<string, any> = {
      released: params.released ?? true,
      archived: params.archived ?? false,
    }

    // Add releaseDate if provided, otherwise use current date when releasing
    if (params.releaseDate) {
      requestBody.releaseDate = params.releaseDate
    } else if (params.released !== false) {
      requestBody.releaseDate = new Date().toISOString().split('T')[0] // YYYY-MM-DD
    }

    if (params.description !== undefined) {
      requestBody.description = params.description
    }

    const url = `${baseUrl}/rest/api/3/version/${params.versionId}`
    const credentials = btoa(`${email}:${token}`)

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()

      logger.error(
        {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
        },
        'Failed to update Jira version',
      )

      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const version = (await response.json()) as JiraVersion

    return {
      success: true,
      version,
    }
  } catch (error) {
    logger.error({ error }, 'Error updating Jira version')

    throw error
  }
}

/**
 * Delivers a Jira release by marking it as released with the current date
 * @param params - Parameters containing the version name
 * @param config - Jira configuration
 * @returns Result containing updated version
 * @throws Error if version not found or update fails
 */
export const deliverJiraRelease = async (
  params: DeliverJiraReleaseParams,
  config: JiraConfig,
): Promise<DeliverJiraReleaseResult> => {
  try {
    const { versionName } = params

    // Find the version by name
    const version = await findVersionByName(versionName, config)

    if (!version) {
      logger.error({ versionName }, 'Jira version not found')
      throw new Error(`Version "${versionName}" not found in Jira project`)
    }

    // Update the version to mark it as released
    const result = await updateJiraVersion(
      {
        versionId: version.id,
        released: true,
        releaseDate: new Date().toISOString().split('T')[0], // Current date in YYYY-MM-DD format
      },
      config,
    )

    return result
  } catch (error) {
    logger.error({ error }, 'Error delivering Jira release')
    throw error
  }
}

/**
 * Loads Jira configuration from environment variables
 * @throws Error with detailed message if configuration is missing or invalid
 * @returns Promise<JiraConfig>
 */
export const loadJiraConfig = async (): Promise<JiraConfig> => {
  const baseUrl = process.env.JIRA_BASE_URL
  const token = process.env.JIRA_TOKEN || process.env.JIRA_API_TOKEN
  const projectIdStr = process.env.JIRA_PROJECT_ID
  const email = process.env.JIRA_EMAIL

  const missingVars: string[] = []

  if (!baseUrl) missingVars.push('JIRA_BASE_URL (e.g., https://your-domain.atlassian.net)')
  if (!token) missingVars.push('JIRA_TOKEN or JIRA_API_TOKEN (your Jira API token)')
  if (!projectIdStr) missingVars.push('JIRA_PROJECT_ID (numeric project ID)')
  if (!email) missingVars.push('JIRA_EMAIL (your Jira email address)')

  if (missingVars.length > 0) {
    const errorMessage = [
      'Jira configuration is required but incomplete.',
      'Please configure the following environment variables:',
      ...missingVars.map((v) => {
        return `  - ${v}`
      }),
      '',
      'You can set these in your .env file or as environment variables.',
    ].join('\n')

    throw new Error(errorMessage)
  }

  const projectId = Number.parseInt(projectIdStr!, 10)

  if (Number.isNaN(projectId)) {
    throw new TypeError(`Invalid JIRA_PROJECT_ID: "${projectIdStr}" must be a numeric value (e.g., 10001)`)
  }

  return {
    baseUrl: baseUrl!.replace(/\/$/, ''), // Remove trailing slash
    token: token!,
    projectId,
    email: email!,
  }
}

/**
 * Attempts to load Jira configuration from environment variables
 * Returns null if configuration is missing or invalid (for optional Jira integration)
 * @returns Promise<JiraConfig | null>
 */
export const loadJiraConfigOptional = async (): Promise<JiraConfig | null> => {
  try {
    const config = await loadJiraConfig()

    return config
  } catch (error) {
    logger.warn({ error }, 'Jira configuration not available, skipping Jira integration')

    return null
  }
}
