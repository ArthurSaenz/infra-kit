import type { RunReport, RunRow, RunSection } from 'src/lib/render/run-report'
import { shellLine } from 'src/lib/shell-quote'
import { recoveryArgv } from 'src/lib/vendor/sync'
import type { CommitResult, TargetPlan } from 'src/lib/vendor/sync'

export type SyncMode = 'preview' | 'check' | 'applied'

export interface TargetOutcome {
  plan: TargetPlan
  applied: boolean
  error?: string
  commit?: CommitResult
}

interface SyncReportOptions {
  mode: SyncMode
  commit?: boolean
  manifestOnly?: boolean
}

const MAX_HOOK_OUTPUT_LINES = 20

const previewNotes = (plan: TargetPlan, options: SyncReportOptions): string[] => {
  if (!options.commit || plan.status !== 'changed' || plan.branch === undefined) return plan.notes

  return [...plan.notes, `--commit lands on ${plan.branch}`]
}

const mainRow = (outcome: TargetOutcome, options: SyncReportOptions): RunRow => {
  const { plan } = outcome
  const name = options.manifestOnly ? 'manifest' : 'sync'

  if (outcome.error !== undefined) {
    return {
      name,
      status: 'fail',
      message: `apply failed: ${outcome.error}`,
      notes: ['restore the tracked paths with:', shellLine(recoveryArgv(plan))],
    }
  }

  const message = outcome.applied ? `wrote ${plan.message}` : plan.message

  return {
    name,
    status: plan.status,
    message,
    notes: options.mode === 'applied' ? plan.notes : previewNotes(plan, options),
  }
}

const commitRow = (commit: CommitResult): RunRow => {
  if (commit.ok) return { name: 'commit', status: 'ok', message: 'committed the synced paths' }

  return {
    name: 'commit',
    status: 'fail',
    message: 'git refused the commit; the files stay written',
    notes: commit.output.split('\n').slice(0, MAX_HOOK_OUTPUT_LINES),
  }
}

const targetSection = (outcome: TargetOutcome, options: SyncReportOptions): RunSection => {
  const warnRows = outcome.plan.warnings.map((warning): RunRow => {
    return { name: 'changelog', status: 'warn', message: warning }
  })

  return {
    label: outcome.plan.name,
    rows: [mainRow(outcome, options), ...warnRows, ...(outcome.commit ? [commitRow(outcome.commit)] : [])],
  }
}

const TITLES: Record<SyncMode, string> = {
  preview: 'infra-kit vendor sync (preview)',
  check: 'infra-kit vendor sync --check',
  applied: 'infra-kit vendor sync',
}

/**
 * One section for the source preflight, then one per target, in factory order.
 *
 * @example
 * syncReport([{ name: 'working tree', status: 'ok', message: 'clean' }], [], { mode: 'preview' })
 */
export const syncReport = (
  sourceRows: readonly RunRow[],
  outcomes: readonly TargetOutcome[],
  options: SyncReportOptions,
): RunReport => {
  const hints = options.mode === 'preview' ? ['re-run with --yes from a real terminal to apply'] : []

  return {
    title: TITLES[options.mode],
    sections: [
      { label: 'source', rows: [...sourceRows] },
      ...outcomes.map((outcome) => {
        return targetSection(outcome, options)
      }),
    ],
    hints,
  }
}

/**
 * True when any row the report would print is `fail`, which is the command's exit-1 condition.
 *
 * @example
 * reportHasFail({ title: 't', sections: [{ label: 's', rows: [{ name: 'r', status: 'fail', message: 'm' }] }] }) // => true
 */
export const reportHasFail = (report: RunReport): boolean => {
  return report.sections.some((section) => {
    return section.rows.some((row) => {
      return row.status === 'fail'
    })
  })
}

/**
 * The applied report minus every row the human already saw in the preview (same section, name and status), so
 * a confirmed run prints only what the apply added — failures, commits — or a one-line result when nothing did.
 *
 * @example
 * appliedDelta(preview, applied, ['hulyo']) // => { title: 'infra-kit vendor sync', sections: [{ label: 'hulyo', rows: [commitRow] }], … }
 */
export const appliedDelta = (preview: RunReport, applied: RunReport, syncedTargets: readonly string[]): RunReport => {
  const seen = new Set(
    preview.sections.flatMap((section) => {
      return section.rows.map((row) => {
        return `${section.label}\0${row.name}\0${row.status}`
      })
    }),
  )
  const sections = applied.sections.map((section): RunSection => {
    return {
      label: section.label,
      rows: section.rows.filter((row) => {
        return !seen.has(`${section.label}\0${row.name}\0${row.status}`)
      }),
    }
  })

  return {
    ...applied,
    sections,
    emptyMessage: `synced ${syncedTargets.join(', ')}`,
  }
}
