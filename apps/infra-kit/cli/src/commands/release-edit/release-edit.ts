import input from '@inquirer/input'
import { z } from 'zod'

import { getReleasePRsWithInfo, updateReleasePRBody } from 'src/integrations/gh'
import { buildJiraVersionUrl, findVersionByName, loadJiraConfig, updateJiraVersion } from 'src/integrations/jira'
import { agentMode, isHeadless } from 'src/lib/agent-mode'
import { commandEcho, confirmOrExit } from 'src/lib/command-echo'
import { OperationError } from 'src/lib/errors/operation-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { logger } from 'src/lib/logger'
import { withEscape } from 'src/lib/prompts/escapable-context'
import { pickReleaseBranch as pickReleaseBranchPrompt } from 'src/lib/prompts/release-picker'
import { assertIsoDate, isoDateOrClearSchema, validateOptionalIsoDate } from 'src/lib/release-date'
import { displayLabel, formatJiraName, parseBranchName } from 'src/lib/release-id'
import {
  buildReleasePrBody,
  formatBranchPickerItems,
  getJiraDescriptions,
  resolveReleaseBranch,
} from 'src/lib/release-utils'
import type { ReleaseType } from 'src/lib/release-utils'
import { defineMcpTool, textContent } from 'src/types'
import type { RequiredConfirmedOptionArg } from 'src/types'

interface ReleaseEditArgs extends RequiredConfirmedOptionArg {
  version?: string
  description?: string
  /** `''` (CLI and MCP alike) and `null` both mean "clear the planned date". */
  releaseDate?: string | null
}

interface EditableFields {
  description: string
  releaseDate: string | null
}

type EditableField = keyof EditableFields

const EDITABLE_FIELDS = ['description', 'releaseDate'] as const

const pickReleaseBranch = async (): Promise<{ branch: string; type: ReleaseType }> => {
  const releasePRsInfo = await getReleasePRsWithInfo()
  const branches = releasePRsInfo.map((pr) => {
    return pr.branch
  })
  const types = new Map<string, ReleaseType>(
    releasePRsInfo.map((pr) => {
      return [pr.branch, pr.type]
    }),
  )
  const descriptions = await getJiraDescriptions()

  const branch = await pickReleaseBranchPrompt(formatBranchPickerItems({ branches, descriptions, types }))

  return { branch, type: types.get(branch) || 'regular' }
}

const verifyReleasePRExists = async (selectedBranch: string): Promise<ReleaseType> => {
  const releasePRsInfo = await getReleasePRsWithInfo()
  const prInfo = releasePRsInfo.find((pr) => {
    return pr.branch === selectedBranch
  })

  if (!prInfo) {
    throw new OperationError(undefined, {
      operation: `edit release ${selectedBranch}`,
      remediation: `confirm an open PR exists for ${selectedBranch} ('gh pr list')`,
    })
  }

  return prInfo.type
}

/**
 * Exported for test only. The keep-current semantics below turn on exactly how the answer is
 * whitespace-normalised, which is the detail that changed when this stopped being a zx `question`.
 */
export const promptDescription = async (current: string): Promise<string> => {
  const hint = current === '' ? '(no current description)' : `current: "${current}"`
  // SINGLE-LINE message on purpose. The hint used to sit on its own line via an embedded `\n`,
  // which zx wrote raw and inquirer cannot: inquirer re-renders on every keystroke and derives
  // its ANSI erase-line count from the rendered message, so a manual newline miscounts and
  // leaves orphaned prompt fragments on screen. Inlining the hint removes the hazard outright
  // rather than testing around it.
  const answer = await withEscape(
    (context) => {
      return input({ message: `  New description ${hint} (press Enter to keep current): ` }, context)
    },
    // A headless run without `--description` is told the flag to pass.
    { whenHeadless: { refuse: 'description' } },
  )
  // `.trim()`, where the zx version only stripped a trailing newline. Whitespace-only input now
  // means keep-current instead of overwriting the description with blanks.
  const trimmed = answer.trim()

  return trimmed === '' ? current : trimmed
}

/**
 * Exported for test only. Enter keeps the current date; clearing one interactively is not offered
 * (that is `--release-date ""`), so the prompt's `validate` never has to distinguish "empty to keep"
 * from "empty to clear".
 */
export const promptReleaseDate = async (current: string | null): Promise<string | null> => {
  const hint = current === null ? '(no current date)' : `current: ${current}`
  const answer = await withEscape(
    (context) => {
      return input(
        {
          message: `  Release date yyyy-mm-dd ${hint} (press Enter to keep current): `,
          validate: validateOptionalIsoDate,
        },
        context,
      )
    },
    { whenHeadless: { refuse: 'releaseDate' } },
  )
  const trimmed = answer.trim()

  return trimmed === '' ? current : assertIsoDate(trimmed)
}

/**
 * CLI `--release-date ""` and MCP `releaseDate: ''` are the same request as `null`, so change
 * detection sees one value for "no date" and clearing an already-empty date is a no-op, not a write.
 */
const normaliseClearIntent = (raw: string | null | undefined): string | null | undefined => {
  if (raw === undefined) return undefined

  return raw === '' ? null : raw
}

const promptFields = async (previous: EditableFields): Promise<EditableFields> => {
  commandEcho.setInteractive()

  return {
    description: await promptDescription(previous.description),
    releaseDate: await promptReleaseDate(previous.releaseDate),
  }
}

const formatDate = (value: string | null): string => {
  return value ?? '(none)'
}

const formatChangeLine = (field: EditableField, previous: EditableFields, next: EditableFields): string => {
  if (field === 'description') return `  description: "${previous.description}" → "${next.description}"`

  return `  release date: ${formatDate(previous.releaseDate)} → ${formatDate(next.releaseDate)}`
}

/**
 * Edit a release's description and/or planned release date on the Jira fix version. A changed
 * description is also mirrored into the matching GitHub release PR body, rewritten canonically to
 * `<jiraVersionUrl>\n\n<description>` (matching `release-create`); the PR body never carries the date.
 */
export const releaseEdit = async (args: ReleaseEditArgs) => {
  const { version: versionArg, description: descriptionArg, releaseDate: releaseDateArg, confirmedCommand } = args
  // Normalised once, at the boundary, so nothing below has to know two spellings of "clear".
  const wantedDate = normaliseClearIntent(releaseDateArg)

  const jiraConfig = await loadJiraConfig()

  let selectedBranch: string

  if (versionArg) {
    selectedBranch = resolveReleaseBranch(versionArg)
    await verifyReleasePRExists(selectedBranch)
  } else {
    commandEcho.setInteractive()
    const picked = await pickReleaseBranch()

    selectedBranch = picked.branch
  }

  // selectedBranch is always a release branch here (operator ref strictly parsed,
  // or picked from discovery-filtered choices), so parseBranchName cannot be null.
  const releaseId = parseBranchName(selectedBranch)

  if (!releaseId) {
    throw new OperationError(undefined, {
      operation: `edit release ${selectedBranch}`,
      remediation: 'pass a version (e.g. "1.2.5") or a release name (e.g. "checkout-redesign")',
    })
  }

  const selectedVersion = displayLabel(releaseId)

  commandEcho.addOption('--version', selectedVersion)

  // Jira fix version is named by the Jira convention: `v1.2.3` | `<name>`.
  const versionName = formatJiraName(releaseId)
  const jiraVersion = await findVersionByName(versionName, jiraConfig)

  if (!jiraVersion) {
    throw new OperationError(undefined, {
      operation: `edit release ${versionName}`,
      remediation: `create the Jira fix version "${versionName}" first or pick a different release`,
    })
  }

  const previous: EditableFields = {
    description: jiraVersion.description ?? '',
    releaseDate: jiraVersion.releaseDate || null,
  }

  const anyFlag = descriptionArg !== undefined || wantedDate !== undefined

  // Keyed on `isHeadless()`, not `isAgentMode()` like the `release-create` precedent: that site
  // pre-empts a whole wizard, whereas this one pre-empts field prompts that themselves refuse on
  // `isHeadless()` — so `--json` without a field must be caught here too, or it would reach
  // `promptDescription` and get the one-flag remediation. Placed after branch + Jira resolution so a
  // missing version or PR still gets its own `OperationError` first.
  if (!anyFlag && isHeadless()) {
    throw new StructuredRefusalError(
      { status: 'argument_required', argument: 'description', agentMode: agentMode.source },
      2,
      {
        operation: 'edit release',
        remediation: 'pass --description and/or --release-date on the re-run',
        stderrExcerpt: 'no field to edit and no human to ask',
      },
    )
  }

  const next = anyFlag
    ? {
        description: descriptionArg ?? previous.description,
        releaseDate: wantedDate === undefined ? previous.releaseDate : wantedDate,
      }
    : await promptFields(previous)

  const changedFields = EDITABLE_FIELDS.filter((field) => {
    return next[field] !== previous[field]
  })
  const descriptionChanged = changedFields.includes('description')
  const dateChanged = changedFields.includes('releaseDate')

  const jiraVersionUrl = buildJiraVersionUrl(jiraConfig, jiraVersion)

  const buildResult = (changed: boolean) => {
    const structuredContent = {
      version: selectedVersion,
      branch: selectedBranch,
      jiraVersionUrl,
      previousDescription: previous.description,
      newDescription: next.description,
      previousReleaseDate: previous.releaseDate,
      newReleaseDate: next.releaseDate,
      changedFields,
      changed,
    }

    return {
      content: textContent(JSON.stringify(structuredContent, null, 2)),
      structuredContent,
    }
  }

  if (changedFields.length === 0) {
    logger.info(
      `No change — ${versionName} already has description "${previous.description}" and release date ${formatDate(previous.releaseDate)}`,
    )
    commandEcho.print()

    return buildResult(false)
  }

  if (descriptionChanged) commandEcho.addOption('--description', next.description)
  if (dateChanged) commandEcho.addOption('--release-date', next.releaseDate ?? '')

  const changeLines = changedFields.map((field) => {
    return formatChangeLine(field, previous, next)
  })

  await confirmOrExit(confirmedCommand, `Update ${versionName}?\n${changeLines.join('\n')}\n`)

  commandEcho.addOption('--yes', true)

  await updateJiraVersion(
    {
      versionId: jiraVersion.id,
      ...(descriptionChanged ? { description: next.description } : {}),
      ...(dateChanged ? { releaseDate: next.releaseDate } : {}),
    },
    jiraConfig,
  )

  if (descriptionChanged) {
    await updateReleasePRBody({ branch: selectedBranch, body: buildReleasePrBody(jiraVersionUrl, next.description) })
  }

  logger.info(`✅ Updated ${changedFields.join(' and ')} for ${versionName}`)
  logger.info(`🔗  Jira Version: ${jiraVersionUrl}`)
  logger.info(`🔗  PR branch: ${selectedBranch}\n`)

  commandEcho.print()

  return buildResult(true)
}

// MCP Tool Registration
export const releaseEditMcpTool = defineMcpTool({
  name: 'release-edit',
  description:
    "Edit a release's description and/or planned release date in Jira; a changed description is mirrored into the GitHub release PR body. Accepts a release version or a release name: targets the Jira fix version named `v<version>` (versioned) or `<name>` (named) and the open PR on branch `release/v<version>` or `release/<name>`. The PR body is rewritten canonically to `<jiraVersionUrl>\\n\\n<description>` — any prior manual edits to the body are overwritten. `version` and at least one of `description`/`releaseDate` are required for MCP calls (the picker and prompts are unreachable without a TTY). Empty string clears a field. Confirmation is auto-skipped for MCP, so the caller is responsible for gating.",
  inputSchema: {
    version: z
      .string()
      .describe('Accepts a release version (e.g. "1.2.5") OR a release name (e.g. "checkout-redesign").'),
    description: z.string().optional().describe('New description. Empty string clears the description.'),
    releaseDate: isoDateOrClearSchema
      .optional()
      .describe('New planned release date (yyyy-mm-dd). Empty string clears the date.'),
  },
  outputSchema: {
    version: z.string().describe('Release version'),
    branch: z.string().describe('Release branch name (e.g. "release/v1.2.5" or "release/checkout-redesign")'),
    jiraVersionUrl: z.string().describe('Jira fix version URL'),
    previousDescription: z.string().describe('The description before the update'),
    newDescription: z.string().describe('The description after the update'),
    previousReleaseDate: z.string().nullable().describe('The planned release date before the update, or null'),
    newReleaseDate: z.string().nullable().describe('The planned release date after the update, or null'),
    changedFields: z.array(z.enum(EDITABLE_FIELDS)).describe('The fields whose value actually changed'),
    changed: z.boolean().describe('Whether anything actually changed'),
  },
  handler: releaseEdit,
})
