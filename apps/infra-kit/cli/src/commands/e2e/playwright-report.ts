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
  /** Tests that passed in some `--repeat-each` repeats and failed in others; Playwright's `flaky` counts retries only. */
  repeatFlaky: number
}

export interface E2eFailure {
  title: string
  file: string
  line: number | null
  project: string
  status: 'unexpected' | 'flaky'
  retry: number
  /** How often the test ran in this project — `--repeat-each` repeats. */
  runs: number
  failedRuns: number
  error: string | null
  tracePath: string | null
}

/** Per spec file: tests that pass while asserting little — a registered known bug, a placeholder, a skip. */
export interface E2eAnnotatedFile {
  file: string
  /** `test.fail` — green only while the bug it registers exists. */
  fail: number
  /** Playwright's fix-me marker — a placeholder, skipped as unfinished. */
  fixme: number
  /** `test.skip`, declared or called at runtime — data-, env- and browser-conditional ones included. */
  skip: number
}

const errorSchema = z.object({ message: z.string().optional() })

const annotationSchema = z.object({ type: z.string() })

const resultSchema = z.object({
  status: z.string(),
  retry: z.number(),
  error: errorSchema.optional(),
  errors: z.array(errorSchema).optional(),
  annotations: z.array(annotationSchema).optional(),
  attachments: z.array(z.object({ name: z.string(), path: z.string().optional() })).optional(),
})

const testSchema = z.object({
  projectName: z.string(),
  status: z.string(),
  expectedStatus: z.string().optional(),
  annotations: z.array(annotationSchema).optional(),
  results: z.array(resultSchema),
})

// The JSON reporter merges every project and every `--repeat-each` repeat of one test into one spec's `tests`.
const specSchema = z.object({
  title: z.string(),
  file: z.string(),
  line: z.number().optional(),
  tests: z.array(testSchema),
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

type ReportTest = z.infer<typeof testSchema>

const isFailedOutcome = (test: ReportTest): boolean => {
  return test.status === 'unexpected' || test.status === 'flaky'
}

/** One test's runs in one project — `--repeat-each` repeats folded together. */
const groupByProject = (tests: ReportTest[]): Map<string, ReportTest[]> => {
  const groups = new Map<string, ReportTest[]>()

  for (const test of tests) groups.set(test.projectName, [...(groups.get(test.projectName) ?? []), test])

  return groups
}

/** Runtime `test.skip()` lands on the result, a declared one on the test; either counts. */
const annotationTypes = (test: ReportTest): Set<string> => {
  return new Set(
    [
      ...(test.annotations ?? []),
      ...test.results.flatMap((result) => {
        return result.annotations ?? []
      }),
    ].map((annotation) => {
      return annotation.type
    }),
  )
}

const failureOf = (
  runs: ReportTest[],
  base: Pick<E2eFailure, 'title' | 'file' | 'line' | 'project'>,
): E2eFailure | null => {
  const failedRuns = runs.filter(isFailedOutcome)
  const lastFailedRun = failedRuns.at(-1)

  if (!lastFailedRun) return null

  // A flaky test ends on a pass; the result worth reading is the last one that failed.
  const failed = lastFailedRun.results.findLast((result) => {
    return result.status !== 'passed' && result.status !== 'skipped'
  })
  const failedEveryRun = failedRuns.length === runs.length && lastFailedRun.status === 'unexpected'

  return {
    ...base,
    status: failedEveryRun ? 'unexpected' : 'flaky',
    retry: failed?.retry ?? 0,
    runs: runs.length,
    failedRuns: failedRuns.length,
    // No failed attempt means a `test.fail()` test that passed — how a broken guard self-test shows up.
    error: failed ? failureMessage(failed) : 'Expected to fail, but passed.',
    tracePath:
      failed?.attachments?.find((attachment) => {
        return attachment.name === 'trace'
      })?.path ?? null,
  }
}

/**
 * Totals plus one entry per test that failed or only passed on retry or on another repeat, or `null`
 * when `raw` is not a Playwright JSON report. The top-level suite is the file itself, so its title stays
 * out of `title`. `annotated` reads what a spec declares, not what a grep of the source would guess.
 */
export const summarizePlaywrightReport = (
  raw: unknown,
): { summary: E2eSummary; failures: E2eFailure[]; annotated: E2eAnnotatedFile[]; errors: string[] } | null => {
  const parsed = reportSchema.safeParse(raw)

  if (!parsed.success) return null

  const { config, suites, errors, stats } = parsed.data
  const failures: E2eFailure[] = []
  const annotated = new Map<string, E2eAnnotatedFile>()
  let repeatFlaky = 0

  const countAnnotations = (file: string, tests: ReportTest[]): void => {
    const types = new Set(
      tests.flatMap((test) => {
        return [...annotationTypes(test)]
      }),
    )
    const declaresFail = tests.some((test) => {
      return test.expectedStatus === 'failed'
    })

    if (!declaresFail && !types.has('fixme') && !types.has('skip')) return

    const entry = annotated.get(file) ?? { file, fail: 0, fixme: 0, skip: 0 }

    if (declaresFail) entry.fail += 1
    if (types.has('fixme')) entry.fixme += 1
    else if (types.has('skip')) entry.skip += 1
    annotated.set(file, entry)
  }

  const visit = (suite: ReportSuite, describePath: string[]): void => {
    for (const spec of suite.specs ?? []) {
      const file = config?.rootDir ? path.resolve(config.rootDir, spec.file) : spec.file
      const title = [...describePath, spec.title].join(' › ')

      countAnnotations(file, spec.tests)

      for (const [project, runs] of groupByProject(spec.tests)) {
        const failure = failureOf(runs, { title, file, line: spec.line ?? null, project })

        if (!failure) continue
        if (failure.runs > 1 && failure.failedRuns < failure.runs) repeatFlaky += 1
        failures.push(failure)
      }
    }

    for (const child of suite.suites ?? []) visit(child, [...describePath, child.title])
  }

  for (const fileSuite of suites) visit(fileSuite, [])

  return {
    summary: {
      expected: stats.expected,
      unexpected: stats.unexpected,
      flaky: stats.flaky,
      skipped: stats.skipped,
      repeatFlaky,
    },
    failures,
    annotated: [...annotated.values()],
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
