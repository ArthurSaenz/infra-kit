import fs from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { z } from 'zod'

const ERROR_LIMIT = 2000

/** `line` keeps a human-readable report on stderr beside the JSON file a caller reads. */
export const JSON_REPORTER_ARG = '--reporter=line,json'

/** Both names: `_FILE` is Playwright ≥1.47, `_NAME` the older spelling, which takes an absolute path too. */
export const jsonReporterEnv = (reportFile: string): Record<string, string> => {
  return { PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile }
}

/** A caller's own `--reporter` wins: CLI reporters replace the config's, so appending ours would drop theirs. */
export const callerPicksReporter = (args: string[]): boolean => {
  return args.some((arg) => {
    return arg === '--reporter' || arg.startsWith('--reporter=')
  })
}

export interface E2eSummary {
  expected: number
  unexpected: number
  flaky: number
  skipped: number
}

export interface E2eFailure {
  title: string
  file: string
  line: number | null
  project: string
  status: 'unexpected' | 'flaky'
  retry: number
  error: string | null
  tracePath: string | null
}

const errorSchema = z.object({ message: z.string().optional() })

const resultSchema = z.object({
  status: z.string(),
  retry: z.number(),
  error: errorSchema.optional(),
  errors: z.array(errorSchema).optional(),
  attachments: z.array(z.object({ name: z.string(), path: z.string().optional() })).optional(),
})

const specSchema = z.object({
  title: z.string(),
  file: z.string(),
  line: z.number().optional(),
  tests: z.array(
    z.object({
      projectName: z.string(),
      status: z.string(),
      results: z.array(resultSchema),
    }),
  ),
})

interface ReportSuite {
  title: string
  specs?: z.infer<typeof specSchema>[]
  suites?: ReportSuite[]
}

const suiteSchema: z.ZodType<ReportSuite> = z.lazy(() => {
  return z.object({
    title: z.string(),
    specs: z.array(specSchema).optional(),
    suites: z.array(suiteSchema).optional(),
  })
})

const reportSchema = z.object({
  config: z.object({ rootDir: z.string().optional() }).optional(),
  suites: z.array(suiteSchema),
  errors: z.array(errorSchema).optional(),
  stats: z.object({ expected: z.number(), unexpected: z.number(), flaky: z.number(), skipped: z.number() }),
})

const cleanMessage = (message: string): string => {
  const plain = stripVTControlCharacters(message)

  return plain.length > ERROR_LIMIT ? `${plain.slice(0, ERROR_LIMIT)}…` : plain
}

const failureMessage = (result: z.infer<typeof resultSchema>): string | null => {
  const message = result.error?.message ?? result.errors?.[0]?.message

  return message === undefined ? null : cleanMessage(message)
}

/**
 * Totals plus one entry per test that failed or only passed on retry, or `null` when `raw` is not a
 * Playwright JSON report. The top-level suite is the file itself, so its title stays out of `title`.
 */
export const summarizePlaywrightReport = (
  raw: unknown,
): { summary: E2eSummary; failures: E2eFailure[]; errors: string[] } | null => {
  const parsed = reportSchema.safeParse(raw)

  if (!parsed.success) return null

  const { config, suites, errors, stats } = parsed.data
  const failures: E2eFailure[] = []

  const visit = (suite: ReportSuite, describePath: string[]): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        if (test.status !== 'unexpected' && test.status !== 'flaky') continue

        // A flaky test ends on a pass; the result worth reading is the last one that failed.
        const failed = test.results.findLast((result) => {
          return result.status !== 'passed' && result.status !== 'skipped'
        })

        failures.push({
          title: [...describePath, spec.title].join(' › '),
          file: config?.rootDir ? path.resolve(config.rootDir, spec.file) : spec.file,
          line: spec.line ?? null,
          project: test.projectName,
          status: test.status,
          retry: failed?.retry ?? 0,
          // No failed attempt means a `test.fail()` test that passed — how a broken guard self-test shows up.
          error: failed ? failureMessage(failed) : 'Expected to fail, but passed.',
          tracePath:
            failed?.attachments?.find((attachment) => {
              return attachment.name === 'trace'
            })?.path ?? null,
        })
      }
    }

    for (const child of suite.suites ?? []) visit(child, [...describePath, child.title])
  }

  for (const fileSuite of suites) visit(fileSuite, [])

  return {
    summary: { expected: stats.expected, unexpected: stats.unexpected, flaky: stats.flaky, skipped: stats.skipped },
    failures,
    // Run-level errors (config, global setup, a spec that fails to import) fail the run with no test to blame.
    errors: (errors ?? []).flatMap((error) => {
      return error.message === undefined ? [] : [cleanMessage(error.message)]
    }),
  }
}

/** Never throws: a run that crashed before the reporter wrote anything reads as `null`. */
export const readPlaywrightReport = (reportFile: string): ReturnType<typeof summarizePlaywrightReport> => {
  try {
    return summarizePlaywrightReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')))
  } catch {
    return null
  }
}
