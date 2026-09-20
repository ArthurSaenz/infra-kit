import process from 'node:process'

import { logger } from 'src/lib/logger'

import { JiraApiError, readSeraphLoginReason } from './jira-api-error.js'
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
 * Throw a classified {@link JiraApiError} when a Jira API response is not OK.
 *
 * Emits at `debug`, not `error`. Severity is not the transport's to decide: the same failed call is
 * fatal to `release create` and merely cosmetic to `worktrees list`, and only the caller that
 * catches knows which. Callers that do not catch surface it through `entry/cli.ts`, which already
 * logs at ERROR and exits 1 — logging here as well is what printed one fault as two red blocks.
 * This line survives as the only record of the raw upstream body; reach it with `--debug`.
 *
 * @param response - The fetch Response to check
 * @param context - Describes the failed operation; becomes the error's prefix
 */
export const assertJiraOk = async (response: Response, context: string): Promise<void> => {
  if (response.ok) {
    return
  }

  const body = await response.text()
  const error = new JiraApiError({
    status: response.status,
    seraphLoginReason: readSeraphLoginReason(response),
    body,
    context,
  })

  logger.debug({ status: response.status, kind: error.kind, body }, context)

  throw error
}

/**
 * The human-facing Jira URL for a fix version's release report.
 *
 * Lives here rather than beside either caller because both of its inputs originate in this
 * module: `release create` needs it for a version it just created *or* reused, and
 * `release edit` needs it for one it looked up. Hoisting it out of the command layer is
 * what lets `lib/release-utils` use it — importing the command's private copy would close a
 * cycle, since that command already imports `lib/release-utils`.
 */
export const buildJiraVersionUrl = (config: JiraConfig, version: Pick<JiraVersion, 'id' | 'projectId'>): string => {
  return `${config.baseUrl}/projects/${version.projectId}/versions/${version.id}/tab/release-report-all-issues`
}

/**
 * Creates a new version in Jira using the REST API
 *
 * @param params - Version creation parameters
 * @param config - Jira configuration (baseUrl, token, projectId)
 * @returns Result containing created version or error
 */
export const createJiraVersion = async (
  params: CreateJiraVersionParams,
  config: JiraConfig,
): Promise<CreateJiraVersionResult> => {
  const { baseUrl, token, email, projectId } = config

  const requestBody = {
    name: params.name,
    projectId: params.projectId || projectId,
    description: params.description || '',
    released: params.released || false,
    archived: params.archived || false,
    ...(params.releaseDate === undefined ? {} : { releaseDate: params.releaseDate }),
  }

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

  await assertJiraOk(response, 'Failed to create Jira version')

  const version = (await response.json()) as JiraVersion

  return {
    success: true,
    version,
  }
}

/**
 * Gets all versions for a project from Jira
 *
 * @param config - Jira configuration
 * @returns Array of JiraVersion objects
 */
export const getProjectVersions = async (config: JiraConfig): Promise<JiraVersion[]> => {
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

  await assertJiraOk(response, 'Failed to get Jira project versions')

  const versions = (await response.json()) as JiraVersion[]

  return versions
}

/**
 * Finds a Jira version by name in the project
 *
 * @param versionName - Name of the version to find (e.g., "v1.33.10")
 * @param config - Jira configuration
 * @returns JiraVersion if found, null otherwise
 */
export const findVersionByName = async (versionName: string, config: JiraConfig): Promise<JiraVersion | null> => {
  const versions = await getProjectVersions(config)
  const version = versions.find((v) => {
    return v.name === versionName
  })

  return version || null
}

/**
 * Updates an existing Jira version
 *
 * Callers express a cleared release date as `releaseDate: null` and never learn the wire form: it
 * is translated here, once. `null` on the PUT is the first attempt at that form — the "Update
 * version" doc (https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-project-versions/#api-rest-api-3-version-id-put)
 * does not state how a set date is unset, and community reports split between `null` and `""`. The
 * echo check below is what makes a wrong guess loud rather than silent.
 *
 * @param params - Update parameters
 * @param config - Jira configuration
 * @returns Result containing updated version or error
 */
export const updateJiraVersion = async (
  params: UpdateJiraVersionParams,
  config: JiraConfig,
): Promise<UpdateJiraVersionResult> => {
  const { baseUrl, token, email } = config

  // Only include fields the caller explicitly passed.
  const requestBody: Record<string, any> = {}

  if (params.released !== undefined) requestBody.released = params.released
  if (params.archived !== undefined) requestBody.archived = params.archived
  if (params.releaseDate !== undefined) requestBody.releaseDate = params.releaseDate
  if (params.description !== undefined) requestBody.description = params.description

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

  await assertJiraOk(response, 'Failed to update Jira version')

  const version = (await response.json()) as JiraVersion

  // Scoped to the clear intent only. A 200 does not prove Jira honoured the payload — an ignored
  // field still answers 200 with the old value — so the echo is the only evidence. Ordinary sets are
  // deliberately NOT compared: Jira may normalise a date it accepted, and `deliverJiraRelease`
  // (`released: true, releaseDate: today`) must never be second-guessed here.
  if (params.releaseDate === null && (version.releaseDate || null) !== null) {
    throw new Error(
      `Jira accepted the update (the write happened) but still reports releaseDate=${version.releaseDate}; the clear payload in updateJiraVersion needs revisiting`,
    )
  }

  return {
    success: true,
    version,
  }
}

/**
 * Delivers a Jira release by marking it as released with the current date
 *
 * Overwriting a planned `releaseDate` with today's is Jira's own meaning of a released version's
 * date — the day it shipped — so the planned date set by `release create` is meant to be replaced.
 *
 * @param params - Parameters containing the version name
 * @param config - Jira configuration
 * @returns Result containing updated version
 * @throws Error if version not found or update fails
 */
export const deliverJiraRelease = async (
  params: DeliverJiraReleaseParams,
  config: JiraConfig,
): Promise<DeliverJiraReleaseResult> => {
  const { versionName } = params

  // Find the version by name
  const version = await findVersionByName(versionName, config)

  if (!version) {
    // No log: this sits inside the `try`, so it is not a tolerance decision, and its own throw
    // already names the version. Logging here made `release deliver` print one fault twice —
    // once here and again at the tolerance site in gh-release-deliver.
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
}

/**
 * Loads Jira configuration from environment variables
 *
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
 *
 * @returns Promise<JiraConfig | null>
 */
export const loadJiraConfigOptional = async (): Promise<JiraConfig | null> => {
  try {
    const config = await loadJiraConfig()

    return config
  } catch (error) {
    // `err` — pino renders an Error under any other key as `{}`, which is what made the old
    // second ERROR line say literally `error: {}`.
    logger.warn({ err: error }, 'Jira configuration not available, skipping Jira integration')

    return null
  }
}
