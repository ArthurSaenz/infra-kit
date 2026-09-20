import { $ } from 'zx'

import { createReleaseBranch } from 'src/integrations/gh'
import {
  buildJiraVersionUrl,
  createJiraVersion,
  findVersionByName,
  getProjectVersions,
  loadJiraConfigOptional,
  updateJiraVersion,
} from 'src/integrations/jira'
import type { JiraConfig, JiraVersion } from 'src/integrations/jira'
import { OperationError } from 'src/lib/errors/operation-error'
import { logger } from 'src/lib/logger'
// Type-only cross-layer import: src/lib/prompts/types.ts is intentionally a
// zero-import leaf so it can be imported from any layer (including this one)
// without creating a cycle.
import type { BranchPickerItem } from 'src/lib/prompts/types'
import { displayLabel, formatBranchName, formatJiraName, parseBranchName, parseReleaseRef } from 'src/lib/release-id'
import type { ReleaseId } from 'src/lib/release-id'

/** Sentinel ref for deploying from the `dev` branch instead of a release branch. */
export const DEV_REF = 'dev'

export type ReleaseType = 'regular' | 'hotfix'

/**
 * The one home of the base↔type mapping: `getBaseBranch` reads it forward, `releaseTypeFromBase`
 * reads it backward, so the two directions cannot drift apart.
 */
const BASE_BRANCH_BY_TYPE: Record<ReleaseType, string> = {
  regular: 'dev',
  hotfix: 'main',
}

/**
 * Get the base branch for a release type.
 * Regular releases branch from/to dev, hotfixes branch from/to main.
 */
export const getBaseBranch = (type: ReleaseType): string => {
  return BASE_BRANCH_BY_TYPE[type]
}

/**
 * Classify a PR by the branch it will actually merge into — the fact, where the title is only a
 * label (`detectReleaseType`). `null` for a base outside the release set: discovery is
 * base-constrained so it treats that as impossible, while a caller that fetched by head has no
 * such constraint and must refuse rather than guess.
 */
export const releaseTypeFromBase = (base: string): ReleaseType | null => {
  const entry = Object.entries(BASE_BRANCH_BY_TYPE).find(([, branch]) => {
    return branch === base
  })

  return entry ? (entry[0] as ReleaseType) : null
}

/**
 * The body of a release PR: the Jira fix-version link, then the description when there is one.
 *
 * Single home for a rule that was written out twice, byte for byte — once where the PR is opened
 * and once where its description is edited. Two copies of a format string drift silently, and the
 * drift only shows up as a PR whose body no longer matches what the other command would write.
 */
export const buildReleasePrBody = (jiraVersionUrl: string, description?: string): string => {
  return (description ?? '').trim() !== '' ? `${jiraVersionUrl}\n\n${description}` : `${jiraVersionUrl} \n`
}

export interface ReleaseCreationResult {
  version: string
  type: ReleaseType
  branchName: string
  prUrl: string
  jiraVersionUrl: string
  /** What the Jira fix version carries after the call — its echo, not the request — or `null`. */
  releaseDate: string | null
}

/**
 * Put the operator's checkout on a freshly fetched base branch and report the SHA it landed
 * on, so the caller can prove that checkout is still the verified one when it finally mutates.
 *
 * `--ff-only` on the pull: without it a base branch that has drifted locally is *merged*
 * rather than refused, which writes a merge commit onto `dev`/`main` in the operator's own
 * checkout and cuts the release from a commit nobody reviewed. Refusing is the safe half of
 * that trade — the cost of a false refusal is one `git pull --rebase`, the cost of a false
 * proceed is a release branch rooted in an accidental merge.
 */
// Quiet is scoped per invocation rather than set on the global `$`. The old form assigned
// `$.quiet = true` and cleared it only after the last successful statement, so any throw in
// between left every later `$` call in the process silent — including the ones whose stderr the
// failure report is built from.
export const prepareGitForRelease = async (type: ReleaseType = 'regular'): Promise<string> => {
  const baseBranch = getBaseBranch(type)
  const git = $({ quiet: true })

  await git`git fetch origin`
  await git`git switch ${baseBranch}`

  try {
    await git`git pull --ff-only origin ${baseBranch}`
  } catch (error) {
    // `nothrow`, because this probe exists only to enrich the refusal. If it fails in turn —
    // `origin/<base>` missing, a broken remote — throwing from here would replace an accurate
    // "your base branch has diverged" with an unrelated error about counting commits.
    const counts = await $({
      quiet: true,
      nothrow: true,
    })`git rev-list --left-right --count origin/${baseBranch}...${baseBranch}`
    const [behind = '?', ahead = '?'] = counts.exitCode === 0 ? counts.stdout.trim().split(/\s+/) : []
    const diverged = ahead !== '0' || behind !== '0'

    // The excerpt is attached ONLY when the branches really have diverged. `buildMessage` gives an
    // explicit `stderrExcerpt` priority over the cause, so an unconditional one would overwrite
    // git's own text on every OTHER `--ff-only` failure — auth, network, a branch with no upstream —
    // and print "local dev is 0 commit(s) ahead and 0 behind" next to advice about diverging. Left
    // off, `extractStderr` walks to the zx error and reports what git actually said.
    throw new OperationError(error, {
      operation: `fast-forward ${baseBranch} onto origin/${baseBranch}`,
      remediation: diverged
        ? `your local ${baseBranch} has diverged — rebase or reset it to origin/${baseBranch}, then retry`
        : `check your access to origin and that ${baseBranch} tracks it, then retry`,
      ...(diverged
        ? { stderrExcerpt: `local ${baseBranch} is ${ahead} commit(s) ahead and ${behind} behind origin/${baseBranch}` }
        : {}),
    })
  }

  return (await git`git rev-parse HEAD`).stdout.trim()
}

interface CreateSingleReleaseArgs {
  id: ReleaseId
  jiraConfig: JiraConfig
  description?: string
  /** Planned production date (`yyyy-mm-dd`), written to the Jira fix version. */
  releaseDate?: string
  type?: ReleaseType
  /** The base-branch SHA from {@link prepareGitForRelease}, forwarded to the branch cut. */
  baseSha: string
}

interface EnsureJiraVersionArgs {
  versionName: string
  jiraConfig: JiraConfig
  description?: string
  releaseDate?: string
}

/**
 * Return the project's fix version named `versionName`, creating it only if it is absent.
 *
 * Idempotent on purpose. `createJiraVersion` POSTs unconditionally and Jira answers a
 * duplicate name with a 4xx, so the unconditional create made a *retry* impossible: the
 * version outlives any later git failure, and the next attempt at the same release dies on
 * the leftover rather than on whatever actually went wrong. Reusing it costs one lookup — the
 * same `getProjectVersions` call this module already makes elsewhere — and keeps the older
 * invariant that a release PR never exists without its fix version.
 */
// Reuse is deliberately not silent about two things:
//
// - A differing description is written through. The PR body is composed from the description
//   passed to THIS call, so a bare reuse would leave the PR and the fix version disagreeing
//   permanently, with nothing to indicate which one is current.
// - A differing release date is written through for the same reason: the confirm summary the
//   human approved shows the date, so Jira has to end up matching it. An ABSENT date never clears
//   one — creating must not be a way to erase.
// - A released or archived version is refused rather than reused. Re-cutting a release whose
//   version was already delivered is a plausible mistake, and quietly attaching a new branch
//   to a closed version would misreport the delivered scope.
const ensureJiraVersion = async (args: EnsureJiraVersionArgs): Promise<JiraVersion> => {
  const { versionName, jiraConfig, description, releaseDate } = args
  const existing = await findVersionByName(versionName, jiraConfig)

  if (!existing) {
    const created = await createJiraVersion(
      {
        name: versionName,
        projectId: jiraConfig.projectId,
        description: description || '',
        released: false,
        archived: false,
        ...(releaseDate === undefined ? {} : { releaseDate }),
      },
      jiraConfig,
    )

    return created.version!
  }

  if (existing.released || existing.archived) {
    throw new OperationError(undefined, {
      operation: `reuse Jira fix version "${versionName}"`,
      remediation: 'pick a different version, or un-release it in Jira first',
      stderrExcerpt: `fix version "${versionName}" is already ${existing.released ? 'released' : 'archived'}`,
    })
  }

  const wanted = description || ''
  const changes = {
    ...(wanted !== '' && wanted !== (existing.description ?? '') ? { description: wanted } : {}),
    ...(releaseDate !== undefined && releaseDate !== (existing.releaseDate ?? '') ? { releaseDate } : {}),
  }

  if (Object.keys(changes).length === 0) return existing

  const updated = await updateJiraVersion({ versionId: existing.id, ...changes }, jiraConfig)

  // The date is read back from the PUT echo, not taken from the request, because it is reported to
  // the caller (`ReleaseCreationResult.releaseDate`) and Jira may normalise it. Nothing reports the
  // description from here — the PR body is built from the request — so it stays as sent.
  return {
    ...existing,
    ...changes,
    ...(changes.releaseDate === undefined ? {} : { releaseDate: updated.version.releaseDate }),
  }
}

/**
 * Create a single release by creating both Jira version and GitHub release branch
 */
export const createSingleRelease = async (args: CreateSingleReleaseArgs): Promise<ReleaseCreationResult> => {
  const { id, jiraConfig, description, releaseDate, type = 'regular', baseSha } = args
  // 1. Ensure the Jira version exists (mandatory). For versioned releases this is
  // "v1.2.3" (byte-identical to before); for named releases it is "<name>".
  const versionName = formatJiraName(id)
  const jiraVersion = await ensureJiraVersion({
    versionName,
    jiraConfig,
    description,
    ...(releaseDate === undefined ? {} : { releaseDate }),
  })
  const jiraVersionUrl = buildJiraVersionUrl(jiraConfig, jiraVersion)

  // 2. Create GitHub release branch
  const releaseInfo = await createReleaseBranch({ id, jiraVersionUrl, type, description, baseSha })

  return {
    version: displayLabel(id),
    type,
    branchName: releaseInfo.branchName,
    prUrl: releaseInfo.prUrl,
    jiraVersionUrl,
    releaseDate: jiraVersion.releaseDate || null,
  }
}

export interface JiraVersionInfo {
  description: string | null
  releaseDate: string | null
}

/**
 * Fetch every Jira fix version's description and planned release date, keyed by version name
 * (`v1.2.5` | `<name>`). Gracefully returns an empty map if Jira is unavailable.
 */
export const getJiraVersionInfo = async (): Promise<Map<string, JiraVersionInfo>> => {
  const info = new Map<string, JiraVersionInfo>()

  const jiraConfig = await loadJiraConfigOptional()

  if (!jiraConfig) return info

  try {
    const versions = await getProjectVersions(jiraConfig)

    for (const version of versions) {
      info.set(version.name, { description: version.description || null, releaseDate: version.releaseDate || null })
    }
  } catch (error) {
    // WARN, not ERROR: the only residue is cosmetic — release rows render without their Jira
    // description. Loud enough to name the likely cause, quiet enough not to claim the command
    // failed when it did not. MUST NOT rethrow: `worktrees list` awaits this inside a
    // `Promise.all`, so throwing here would take the whole listing down over missing decoration.
    logger.warn(
      { err: error },
      'Jira descriptions unavailable — the release list will render without them. If this persists, check JIRA_EMAIL / JIRA_TOKEN.',
    )
  }

  return info
}

/**
 * Jira version descriptions keyed by version name; versions without a description have no entry,
 * so a `.get()` miss reads the same for "no description" and "Jira unavailable".
 */
export const getJiraDescriptions = async (): Promise<Map<string, string>> => {
  const info = await getJiraVersionInfo()

  return new Map(
    [...info].flatMap(([name, { description }]) => {
      return description ? [[name, description] as const] : []
    }),
  )
}

/**
 * Format a version string with its release type tag, e.g. "1.2.5   [regular]"
 * When maxVersionLength is provided, pads the version for alignment.
 */
export const formatVersionLabel = (version: string, type: ReleaseType, maxVersionLength?: number): string => {
  const padding = maxVersionLength ? ' '.repeat(maxVersionLength - version.length + 3) : '   '
  const tag = `[${type}]`.padEnd(11)

  return `${version}${padding}${tag}`
}

/**
 * Detect release type from PR title.
 * PRs titled "Hotfix v..." are hotfix, everything else is regular.
 */
export const detectReleaseType = (title: string): ReleaseType => {
  return title.toLowerCase().startsWith('hotfix') ? 'hotfix' : 'regular'
}

interface FormatBranchChoicesArgs {
  branches: string[]
  descriptions: Map<string, string>
  types?: Map<string, ReleaseType>
}

interface ParsedBranchChoice {
  branch: string
  id: ReleaseId
  /** Human display label: `1.2.3` | `<name>`. */
  label: string
}

/**
 * Parse branches into release ids, dropping any that do not parse (lenient
 * discovery source). Exported for unit testing the version/name/junk split.
 */
export const parseBranchChoices = (branches: string[]): ParsedBranchChoice[] => {
  return branches.flatMap((branch) => {
    const id = parseBranchName(branch)

    if (!id) return []

    return [{ branch, id, label: displayLabel(id) }]
  })
}

/**
 * Resolve an operator-supplied release ref (version `1.2.3` / `v1.2.3` or name
 * `checkout-redesign`) to its branch name (`release/v1.2.3` | `release/<name>`).
 * Strict: surfaces a parse failure as an OperationError with remediation text.
 */
export const resolveReleaseBranch = (versionArg: string): string => {
  try {
    return formatBranchName(parseReleaseRef(versionArg))
  } catch (error) {
    // `OperationError` never renders `cause.message`, so without the excerpt the parser's reason —
    // including its `@date` hint for a pasted `release create` spec — would be dropped here.
    throw new OperationError(error, {
      operation: `resolve release ref "${versionArg}"`,
      remediation: 'pass a version (e.g. "1.2.5") or a release name (e.g. "checkout-redesign")',
      stderrExcerpt: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Render the human display label for a release branch. Returns the `dev`
 * sentinel unchanged; otherwise derives `1.2.3` | `<name>` from the branch.
 * Falls back to the raw branch when it does not parse as a release id.
 */
export const releaseLabelFromBranch = (branch: string): string => {
  if (branch === DEV_REF) return DEV_REF

  const id = parseBranchName(branch)

  return id ? displayLabel(id) : branch
}

/**
 * Render human display labels for a list of release branches, dropping any
 * branch that does not parse as a release id (lenient discovery contract).
 */
export const releaseBranchLabels = (branches: string[]): string[] => {
  return branches.flatMap((branch) => {
    const id = parseBranchName(branch)

    return id ? [displayLabel(id)] : []
  })
}

const deriveBranchType = (branch: string, types?: Map<string, ReleaseType>): ReleaseType | undefined => {
  return types ? types.get(branch) || 'regular' : undefined
}

/**
 * Format release branch names as Ink picker items. Labels and descriptions
 * are returned as separate fields — the picker renders and pads them itself.
 */
export const formatBranchPickerItems = (args: FormatBranchChoicesArgs): BranchPickerItem[] => {
  const { branches, descriptions, types } = args

  return parseBranchChoices(branches).map(({ branch, id, label }) => {
    return {
      value: branch,
      label,
      // Jira-descriptions map is keyed by the Jira version NAME (`v1.2.3` | `<name>`).
      description: descriptions.get(formatJiraName(id)),
      type: deriveBranchType(branch, types),
    }
  })
}
