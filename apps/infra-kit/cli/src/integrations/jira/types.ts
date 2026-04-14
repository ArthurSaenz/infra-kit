/**
 * Jira Version API types
 */

export interface JiraVersion {
  /** ID of the version */
  id: string
  /** URL of the version */
  self: string
  /** Name of the version */
  name: string
  /** Description of the version */
  description?: string
  /** Whether the version is archived */
  archived: boolean
  /** Whether the version is released */
  released: boolean
  /** Release date in ISO format (YYYY-MM-DD) */
  releaseDate?: string
  /** User-friendly release date */
  userReleaseDate?: string
  /** Project key */
  project?: string
  /** Project ID */
  projectId: number
}

export interface CreateJiraVersionParams {
  /** Name of the version (e.g., "v1.2.5") */
  name: string
  /** Project ID (numeric) */
  projectId: number
  /** Description of the version */
  description?: string
  /** Release date in ISO format (YYYY-MM-DD). Defaults to current date if not provided */
  releaseDate?: string
  /** Whether the version is released. Defaults to true */
  released?: boolean
  /** Whether the version is archived. Defaults to false */
  archived?: boolean
}

export interface JiraConfig {
  /** Jira base URL (e.g., https://your-domain.atlassian.net) */
  baseUrl: string
  /** Jira API token */
  token: string
  /** Jira project ID */
  projectId: number
  /** Email associated with Jira account (for Basic Auth) */
  email: string
}

export interface CreateJiraVersionResult {
  success: boolean
  version: JiraVersion
}

export interface UpdateJiraVersionParams {
  /** ID of the version to update */
  versionId: string
  /** Whether the version is released */
  released?: boolean
  /** Release date in ISO format (YYYY-MM-DD) */
  releaseDate?: string
  /** Description of the version */
  description?: string
  /** Whether the version is archived */
  archived?: boolean
}

export interface UpdateJiraVersionResult {
  success: boolean
  version: JiraVersion
}

export interface DeliverJiraReleaseParams {
  /** Name of the version to deliver (e.g., "v1.33.10") */
  versionName: string
}

export interface DeliverJiraReleaseResult {
  success: boolean
  version: JiraVersion
}
