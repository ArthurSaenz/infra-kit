import { z } from 'zod'
import { $ } from 'zx'

import { getProjectRoot } from 'src/lib/git-utils'
import { revParseVerify } from 'src/lib/git-utils/merge-refs'
import { logger } from 'src/lib/logger'
import { defineMcpTool, textContent } from 'src/types'

import {
  FIX_SUBJECT_PATTERN,
  FOLLOW_UP_IGNORED_FILES,
  FOLLOW_UP_WINDOW_HOURS,
  GIT_LOG_FORMAT,
  MIN_COMPARISON_N,
  compareRates,
  computeClassStats,
  parseGitLog,
} from './analyze'
import type { ClassStats, ParsedCommit, Rate } from './analyze'

export const DEFAULT_SINCE_DAYS = 90

const DAY_MS = 86_400_000

/**
 * Commits reachable from HEAD since the cutoff, oldest first. Merge commits are
 * dropped: they carry no authored change of their own, and their `--name-only` lists every file the
 * merged branch touched, which would make each merge "share a file" with half the window.
 */
const readCommits = async (cwd: string, sinceIso: string): Promise<ParsedCommit[]> => {
  // `git log` on an unborn HEAD is a fatal, not an empty list.
  if ((await revParseVerify(cwd, 'HEAD')) === null) return []

  const sinceArg = `--since=${sinceIso}`
  const result = await $({ cwd, quiet: true })`git log --no-merges --name-only ${sinceArg} ${GIT_LOG_FORMAT}`

  // git prints newest first; reversing before the stable sort keeps same-second commits in commit order.
  return parseGitLog(result.stdout)
    .toReversed()
    .sort((a, b) => {
      return a.committedAt - b.committedAt
    })
}

/**
 * Change-failure baseline for the repo at `cwd`: commits classified agent/human by trailer, with revert
 * rate and 72h follow-up-fix rate per class. Split from {@link changeStats} so tests pass a temp repo and
 * a fixed clock instead of `cd`-ing the process.
 */
export const collectChangeStats = async ({
  cwd,
  sinceDays,
  nowMs,
}: {
  cwd: string
  sinceDays: number
  nowMs: number
}) => {
  const from = new Date(nowMs - sinceDays * DAY_MS).toISOString()
  const commits = await readCommits(cwd, from)
  const classes = computeClassStats(commits, Math.floor(nowMs / 1000))

  return {
    repoRoot: cwd,
    sinceDays,
    from,
    until: new Date(nowMs).toISOString(),
    classes,
    comparison: {
      minN: MIN_COMPARISON_N,
      revertRate: compareRates(classes.agent.revertRate, classes.human.revertRate),
      followUpFixRate: compareRates(classes.agent.followUpFixRate, classes.human.followUpFixRate),
    },
    heuristics: {
      agentTrailers: ['Co-Authored-By: Claude…', 'Claude-Session:'],
      fixSubjectPattern: FIX_SUBJECT_PATTERN.source,
      followUpWindowHours: FOLLOW_UP_WINDOW_HOURS,
      followUpIgnoredFiles: FOLLOW_UP_IGNORED_FILES,
      mergesExcluded: true,
    },
  }
}

const percent = (value: number): string => {
  return `${(value * 100).toFixed(1)}%`
}

const formatRate = (rate: Rate): string => {
  if (rate.rate === null || !rate.ci95) return `n/a (n=0)`

  return `${percent(rate.rate)} (${rate.hits}/${rate.n}, 95% CI ${percent(rate.ci95.low)}–${percent(rate.ci95.high)})`
}

const formatClass = (label: string, stats: ClassStats): string => {
  return [
    `  ${label}: ${stats.commits} commits (${stats.reverts} reverts)`,
    `    revert rate:            ${formatRate(stats.revertRate)}`,
    `    ${FOLLOW_UP_WINDOW_HOURS}h follow-up-fix rate: ${formatRate(stats.followUpFixRate)}`,
  ].join('\n')
}

/**
 * Read-only `infra-kit change-stats`: the change-failure baseline the roadmap re-runs at +30 days to see
 * whether agent and human changes fail differently. Runs in any git repo — no infra-kit config needed.
 *
 * @example
 * await changeStats({ since: 30 })
 * // => structuredContent.classes.agent.revertRate: { hits: 1, n: 120, rate: 0.0083, ci95: { … } }
 */
export const changeStats = async ({ since = DEFAULT_SINCE_DAYS }: { since?: number }) => {
  const structuredContent = await collectChangeStats({
    cwd: await getProjectRoot(),
    sinceDays: since,
    nowMs: Date.now(),
  })

  const { classes, comparison } = structuredContent

  logger.info(
    `Change stats for ${structuredContent.repoRoot} — last ${since} days (${structuredContent.from.slice(0, 10)} → ${structuredContent.until.slice(0, 10)}, merges excluded)`,
  )
  logger.info(formatClass('agent', classes.agent))
  logger.info(formatClass('human', classes.human))
  logger.info(formatClass('total', classes.total))

  const describe = (name: string, result: (typeof comparison)['revertRate']): string => {
    if (result.suppressed) return `  ${name}: comparison suppressed (${result.reason})`

    const overlap = result.intervalsOverlap ? 'intervals overlap' : 'intervals do not overlap'

    return `  ${name}: agent − human = ${percent(result.difference ?? 0)} (${overlap})`
  }

  logger.info(
    [
      'Agent vs human:',
      describe('revert rate', comparison.revertRate),
      describe('follow-up-fix rate', comparison.followUpFixRate),
    ].join('\n'),
  )

  return {
    content: textContent(JSON.stringify(structuredContent, null, 2)),
    structuredContent,
  }
}

const rateSchema = z.object({
  hits: z.number().describe('Changes that hit the metric'),
  n: z.number().describe('Changes the rate is computed over'),
  rate: z.number().nullable().describe('hits / n, rounded to 4 places; null when n is 0'),
  ci95: z
    .object({ low: z.number(), high: z.number() })
    .nullable()
    .describe('Wilson 95% score interval; null when n is 0'),
})

const classSchema = z.object({
  commits: z.number().describe('Non-merge commits in range for this class'),
  reverts: z.number().describe('Of those, revert commits (excluded from both rate denominators)'),
  changes: z.number().describe('Non-revert commits — the revert-rate denominator'),
  revertRate: rateSchema.describe('Changes later reverted by an in-range commit'),
  followUpFixRate: rateSchema.describe(
    'Changes at least 72h old followed within 72h by a fix-subject commit touching a shared file',
  ),
})

const comparisonSchema = z.object({
  suppressed: z.boolean().describe('True when either class has n below minN'),
  reason: z.string().nullable(),
  difference: z.number().nullable().describe('agent rate − human rate'),
  intervalsOverlap: z.boolean().nullable().describe('Whether the two Wilson intervals overlap'),
})

export const changeStatsMcpTool = defineMcpTool({
  name: 'change-stats',
  description:
    'Read-only change-failure baseline for the git repo at cwd: commits classified agent (Claude trailers) vs human, with revert rate and 72h follow-up-fix rate per class, each with n and a Wilson 95% interval. The agent-vs-human comparison is suppressed when either n < 30.',
  inputSchema: {
    since: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Window in days, ending now (default ${DEFAULT_SINCE_DAYS})`),
  },
  outputSchema: {
    repoRoot: z.string().describe('git toplevel the stats were read from'),
    sinceDays: z.number(),
    from: z.string().describe('ISO start of the window'),
    until: z.string().describe('ISO end of the window (now)'),
    classes: z.object({ agent: classSchema, human: classSchema, total: classSchema }),
    comparison: z.object({
      minN: z.number(),
      revertRate: comparisonSchema,
      followUpFixRate: comparisonSchema,
    }),
    heuristics: z.object({
      agentTrailers: z.array(z.string()),
      fixSubjectPattern: z.string(),
      followUpWindowHours: z.number(),
      followUpIgnoredFiles: z.array(z.string()),
      mergesExcluded: z.boolean(),
    }),
  },
  handler: changeStats,
})
