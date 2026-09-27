import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { agentMode, isAgentMode } from 'src/lib/agent-mode'
import { confirmOrExit } from 'src/lib/command-echo'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { vendorSourceSchema } from 'src/lib/infra-kit-config'
import type { VendorSourceConfig } from 'src/lib/infra-kit-config'
import { jsonOutput } from 'src/lib/json-output'
import { printRunReport } from 'src/lib/render/run-report'
import type { RunReport, RunRow } from 'src/lib/render/run-report'
import { shellLine } from 'src/lib/shell-quote'
import { expandTilde, loadFactoryConfig } from 'src/lib/vendor/factory-config'
import type { FactoryConfig } from 'src/lib/vendor/factory-config-schema'
import {
  applyTargetPlan,
  commitSyncedPaths,
  probeSource,
  recoveryArgv,
  syncCommitMessage,
  writeVendorMetaOnly,
} from 'src/lib/vendor/sync'
import type { SourceFacts, TargetPlan } from 'src/lib/vendor/sync'

import { reportHasFail, syncReport } from './report'
import type { SyncMode, TargetOutcome } from './report'
import { preflightSource } from './source-preflight'
import { planTargets, selectTargets } from './targets'

export interface VendorSyncOptions {
  /** Target names from `~/.infra-kit/vendor.json`; empty means every target. */
  targets?: string[]
  confirmedCommand?: boolean
  check?: boolean
  commit?: boolean
  manifestOnly?: boolean
}

const OPERATION = 'sync vendored files'

// `--yes` is no answer here: a sync rewrites files in every target repo, so no agent confirms it for a
// human. Placed before any config read so an agent learns nothing it could act on.
const refuseAgentMode = (): void => {
  if (!isAgentMode()) return

  throw new StructuredRefusalError({ status: 'refused', agentMode: agentMode.source }, 2, {
    operation: OPERATION,
    stderrExcerpt: 'vendor sync is human-only: refused in agent mode regardless of --yes',
    remediation:
      'ask a human to run `infra-kit vendor sync` from their own shell — a sync is never confirmed by an agent',
  })
}

// `INFRA_KIT_AGENT=0` clears the agent heuristic, so an agent's Bash could still reach the apply with
// `--yes`; a real terminal on stdin is the one thing it cannot fake.
const refuseWithoutTty = (): void => {
  if (process.stdin.isTTY) return

  throw new StructuredRefusalError({ status: 'refused', reason: 'no-tty' }, 2, {
    operation: OPERATION,
    stderrExcerpt: 'the apply needs a real terminal on stdin',
    remediation: "run `infra-kit vendor sync --yes` from a real terminal; Claude Code's `!` prefix is not one",
  })
}

// The source comes from the factory config, never from the cwd, so a sync runs the same from any directory.
const resolveSourceRoot = (factory: FactoryConfig): string => {
  const sourceRoot = path.join(expandTilde(factory.workspaceDir), factory.source)

  if (existsSync(sourceRoot)) return sourceRoot

  throw new StructuredRefusalError({ status: 'refused', reason: 'source-missing', source: sourceRoot }, 1, {
    operation: OPERATION,
    stderrExcerpt: `the source repo ${factory.source} is not checked out at ${sourceRoot}`,
    remediation: 'clone it there, or fix "source" / "workspaceDir" in ~/.infra-kit/vendor.json',
  })
}

const notAVendorSource = (configPath: string, detail: string): StructuredRefusalError => {
  return new StructuredRefusalError({ status: 'refused', reason: 'not-a-vendor-source' }, 1, {
    operation: OPERATION,
    stderrExcerpt: `${configPath} ${detail}`,
    remediation:
      'add a vendorSource block to the source repo\'s committed infra-kit.json, or point "source" at the repo that has one',
  })
}

// Only the committed project file is read: `vendorSource` is refused in every ~/.infra-kit layer, and the
// merged loader is cwd-bound and may migrate the file on disk, which would dirty the source after the
// clean-tree check.
const readVendorSource = async (sourceRoot: string): Promise<VendorSourceConfig> => {
  const configPath = path.join(sourceRoot, 'infra-kit.json')
  let raw: unknown

  try {
    raw = JSON.parse(await fs.readFile(configPath, 'utf8'))
  } catch (error) {
    throw notAVendorSource(configPath, `is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }

  const vendorSource = (raw as { vendorSource?: unknown } | null)?.vendorSource

  if (vendorSource === undefined || vendorSource === null)
    throw notAVendorSource(configPath, 'has no vendorSource block')

  const parsed = vendorSourceSchema.safeParse(vendorSource)

  if (!parsed.success)
    throw notAVendorSource(configPath, `has an invalid vendorSource: ${z.prettifyError(parsed.error)}`)

  return parsed.data
}

const printRecovery = (plan: TargetPlan, argv: string[]): void => {
  process.stderr.write(`${plan.name}: if this run dies, restore the tracked paths with:\n  ${shellLine(argv)}\n`)
}

const writeTarget = async (source: SourceFacts, plan: TargetPlan, manifestOnly: boolean): Promise<string[]> => {
  if (!manifestOnly) {
    const result = await applyTargetPlan({
      source,
      plan,
      onBeforeFirstWrite: (argv) => {
        printRecovery(plan, argv)
      },
    })

    return result.touched
  }

  printRecovery(plan, recoveryArgv(plan))

  return writeVendorMetaOnly(plan.root, source)
}

const applyOne = async (source: SourceFacts, plan: TargetPlan, options: VendorSyncOptions): Promise<TargetOutcome> => {
  if (plan.status !== 'changed') return { plan, applied: false }

  let touched: string[]

  try {
    touched = await writeTarget(source, plan, Boolean(options.manifestOnly))
  } catch (error) {
    return { plan, applied: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (!options.commit) return { plan, applied: true }

  const commit = await commitSyncedPaths(plan.root, touched, syncCommitMessage(source.name, source.headSha))

  return { plan, applied: true, commit }
}

// Sequential on purpose: the recovery argv printed before each target's first write must stay next to
// that target's output, and one failure must not stop the targets after it.
const applyAll = async (
  source: SourceFacts,
  plans: readonly TargetPlan[],
  options: VendorSyncOptions,
): Promise<TargetOutcome[]> => {
  const outcomes: TargetOutcome[] = []

  for (const plan of plans) {
    outcomes.push(await applyOne(source, plan, options))
  }

  return outcomes
}

const planPayload = (plans: readonly TargetPlan[]) => {
  return plans.map((plan) => {
    return {
      name: plan.name,
      root: plan.root,
      status: plan.status,
      message: plan.message,
      notes: plan.notes,
      warnings: plan.warnings,
      branch: plan.branch,
    }
  })
}

interface FinishInput {
  mode: SyncMode
  report: RunReport
  outcomes: readonly TargetOutcome[]
  source: SourceFacts
  /** False when the human already saw this exact report before the confirm. */
  print: boolean
}

const finish = ({ mode, report, outcomes, source, print }: FinishInput) => {
  if (print) printRunReport(report)

  const plans = outcomes.map((outcome) => {
    return outcome.plan
  })
  const structuredContent = {
    mode,
    source: { root: source.root, name: source.name, headSha: source.headSha },
    targets: planPayload(plans).map((row, index) => {
      const outcome = outcomes[index]!

      return { ...row, applied: outcome.applied, error: outcome.error, commit: outcome.commit }
    }),
    changed: plans.some((plan) => {
      return plan.status === 'changed'
    }),
    failed: reportHasFail(report),
    report: report.sections,
  }

  return { structuredContent }
}

interface Prepared {
  source: SourceFacts
  sourceRows: RunRow[]
  plans: TargetPlan[]
}

const prepare = async (options: VendorSyncOptions): Promise<Prepared> => {
  const factory = await loadFactoryConfig()
  const sourceRoot = resolveSourceRoot(factory)
  const sourceRows = await preflightSource(sourceRoot)
  const spec = await readVendorSource(sourceRoot)
  const refs = selectTargets(factory, options.targets ?? [])
  const source = await probeSource(sourceRoot, spec)
  const plans = await planTargets(source, refs, Boolean(options.manifestOnly))

  return { source, sourceRows, plans }
}

/**
 * Mirror the factory source repo's `vendorSource.copy` entries into every factory target, from any cwd: preview, confirm, then
 * apply target by target, with an optional per-target commit. Human-only: refused under agent mode even with
 * `--yes`, and the apply needs a real terminal on stdin. Never calls `process.exit`; the CLI action maps
 * `failed` (and `changed` under `--check`) to the exit code.
 *
 * @example
 * await vendorSync({ check: true })                       // drift report, exit 1 when any target would change
 * await vendorSync({ targets: ['hulyo'], confirmedCommand: true, commit: true })
 */
export const vendorSync = async (options: VendorSyncOptions = {}) => {
  refuseAgentMode()

  const { source, sourceRows, plans } = await prepare(options)
  const outcomes = plans.map((plan): TargetOutcome => {
    return { plan, applied: false }
  })
  const reportOptions = { commit: options.commit, manifestOnly: options.manifestOnly }
  const previewMode: SyncMode = options.check ? 'check' : 'preview'
  const preview = syncReport(sourceRows, outcomes, { ...reportOptions, mode: previewMode })
  const nothingToApply = !plans.some((plan) => {
    return plan.status === 'changed'
  })

  if (options.check || nothingToApply)
    return finish({ mode: previewMode, report: preview, outcomes, source, print: true })

  const humanPreview = !options.confirmedCommand && !jsonOutput.enabled

  if (humanPreview) printRunReport(preview)
  if (humanPreview && !process.stdin.isTTY) {
    return finish({ mode: 'preview', report: preview, outcomes, source, print: false })
  }

  await confirmOrExit(options.confirmedCommand, `Sync vendored files from ${source.name} into these targets?`, {
    plan: planPayload(plans),
    throwOnDecline: true,
  })
  refuseWithoutTty()

  const applied = await applyAll(source, plans, options)
  const report = syncReport(sourceRows, applied, { ...reportOptions, mode: 'applied' })

  return finish({ mode: 'applied', report, outcomes: applied, source, print: true })
}
