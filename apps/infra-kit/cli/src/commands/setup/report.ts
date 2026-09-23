/**
 * `setup`'s end-of-run table: the three vocabularies its steps speak (init outcomes, tool actions, the
 * portless step's outcomes) mapped onto the one `RunStatus` vocabulary the shared renderer draws.
 *
 * Pure: it takes what the run returned and produces rows. It prints nothing and decides nothing about
 * the exit code, beyond giving `setup` the rows that rule reads.
 */
import type { ServiceTargetState } from 'src/commands/doctor/doctor'
import { SHELL_ACTIVATION_REMINDER } from 'src/commands/init/init'
import type { InitEntry, InitOutcome, InitStepName } from 'src/commands/init/init'
import type { PortlessLinkOutcome } from 'src/dev/proxy/portless-link'
import type { PortlessNodeResult } from 'src/dev/proxy/portless-node'
import { assertNever } from 'src/lib/assert-never/assert-never'
import type { RunRow, RunSection, RunStatus } from 'src/lib/render/run-report'

import type { ToolResult } from './converge'

export interface SetupReportInput {
  init: readonly InitEntry[]
  tools: readonly ToolResult[]
  portless: {
    link: PortlessLinkOutcome
    node: PortlessNodeResult
    service: ServiceTargetState | 'skipped'
    command: string | null
  }
}

export interface SetupReportMode {
  skipTools: boolean
}

/**
 * The init steps in the order `initCore` runs them. A `Record` rather than an array so a new
 * `InitStepName` without a position fails `ts-check` instead of silently losing its row.
 */
const INIT_STEP_ORDER: Record<InitStepName, number> = {
  zshrc: 0,
  zshenv: 1,
  migrations: 2,
  'user-config': 3,
  guidance: 4,
  'plugin-pointer': 5,
  'mcp-server': 6,
  'mcp-proxies': 7,
  'project-config': 8,
  shell: 9,
}

export const INIT_STEPS = (Object.keys(INIT_STEP_ORDER) as InitStepName[]).sort((a, b) => {
  return INIT_STEP_ORDER[a] - INIT_STEP_ORDER[b]
})

/**
 * Worst wins. `manual` outranks `changed` so a step that wrote something and still needs a human
 * command shows as needing the human.
 */
const SEVERITY: Record<RunStatus, number> = { skipped: 0, ok: 1, changed: 2, manual: 3, warn: 4, fail: 5 }

/** Only these become notes; the rest are summarised in the row message. */
const NOTE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['manual', 'warn', 'fail'])

export const initEntryStatus = (outcome: InitOutcome): RunStatus => {
  switch (outcome) {
    case 'written': {
      return 'changed'
    }
    case 'unchanged': {
      return 'ok'
    }
    case 'skipped': {
      return 'skipped'
    }
    case 'manual': {
      return 'manual'
    }
    case 'warned': {
      return 'warn'
    }
    case 'failed': {
      return 'fail'
    }
    default: {
      return assertNever(outcome)
    }
  }
}

export const worstStatus = (statuses: readonly RunStatus[]): RunStatus => {
  return statuses.reduce<RunStatus>((worst, status) => {
    return SEVERITY[status] > SEVERITY[worst] ? status : worst
  }, 'skipped')
}

/** A row message is one line; indentation some producers add for their own stream is not part of it. */
const entryText = (entry: InitEntry): string => {
  return entry.message.trim()
}

/**
 * `4 written · 1 unchanged`, in the source vocabulary so the words match the JSON `init` outcomes.
 * Fixed order, zero counts dropped.
 */
const countSummary = (entries: readonly InitEntry[]): string => {
  const order: InitOutcome[] = ['written', 'unchanged', 'skipped']

  return order
    .map((outcome) => {
      const count = entries.filter((entry) => {
        return entry.outcome === outcome
      }).length

      return count > 0 ? `${count} ${outcome}` : ''
    })
    .filter((part) => {
      return part.length > 0
    })
    .join(' · ')
}

/**
 * The shell step's only routine entry is the activation reminder, which `setup` prints once as its last
 * line. Repeating it in the row would print it twice, so the row points at it instead.
 */
const isReminder = (entry: InitEntry): boolean => {
  return entry.message === SHELL_ACTIVATION_REMINDER
}

const summaryMessage = (summarised: readonly InitEntry[], hasReminder: boolean): string => {
  const [only] = summarised

  if (summarised.length === 1 && only !== undefined) return entryText(only)

  if (summarised.length > 1) return countSummary(summarised)

  return hasReminder ? 'activate with the last line below' : 'see below'
}

/** One row for one init step, folding every entry that step recorded. */
const initStepRow = (step: InitStepName, entries: readonly InitEntry[]): RunRow => {
  if (entries.length === 0) return { name: step, status: 'skipped', message: 'did not run' }

  const statuses = entries.map((entry) => {
    return initEntryStatus(entry.outcome)
  })
  // Chosen by MAPPED status, never by pino `level`: the plugin commands are `info`-level `manual`
  // entries, and selecting by level would drop the one thing the human has to copy.
  const notes = entries
    .filter((entry) => {
      return NOTE_STATUSES.has(initEntryStatus(entry.outcome))
    })
    .map(entryText)
  const summarised = entries.filter((entry) => {
    return !NOTE_STATUSES.has(initEntryStatus(entry.outcome)) && !isReminder(entry)
  })
  const row: RunRow = {
    name: step,
    status: worstStatus(statuses),
    message: summaryMessage(summarised, entries.some(isReminder)),
  }

  return notes.length > 0 ? { ...row, notes } : row
}

const initSection = (entries: readonly InitEntry[]): RunSection => {
  return {
    label: 'Local setup',
    rows: INIT_STEPS.map((step) => {
      return initStepRow(
        step,
        entries.filter((entry) => {
          return entry.step === step
        }),
      )
    }),
  }
}

export const toolStatus = (tool: ToolResult, mode: SetupReportMode): RunStatus => {
  switch (tool.action) {
    case 'installed':
    case 'updated': {
      return 'changed'
    }
    case 'skipped': {
      // Under the probe, a skip that carries argv is exactly "run these yourself"; one without argv
      // had nothing to do.
      return mode.skipTools && tool.commands.length > 0 ? 'manual' : 'skipped'
    }
    case 'refused': {
      return 'manual'
    }
    case 'failed': {
      return 'fail'
    }
    default: {
      return assertNever(tool.action)
    }
  }
}

const toolRow = (tool: ToolResult, mode: SetupReportMode): RunRow => {
  const status = toolStatus(tool, mode)
  const row: RunRow = { name: tool.id, status, message: tool.detail }

  return status === 'manual' && tool.commands.length > 0 ? { ...row, notes: [...tool.commands] } : row
}

const toolsSection = (tools: readonly ToolResult[], mode: SetupReportMode): RunSection => {
  return {
    label: mode.skipTools ? 'Tools (probe: nothing installed)' : 'Tools',
    rows: tools.map((tool) => {
      return toolRow(tool, mode)
    }),
  }
}

export const portlessLinkStatus = (outcome: PortlessLinkOutcome): RunStatus => {
  switch (outcome) {
    case 'created':
    case 'repointed': {
      return 'changed'
    }
    case 'unchanged': {
      return 'ok'
    }
    case 'skipped-local':
    case 'skipped-unresolved': {
      return 'skipped'
    }
    case 'failed': {
      return 'fail'
    }
    default: {
      return assertNever(outcome)
    }
  }
}

export const portlessNodeStatus = (outcome: PortlessNodeResult['outcome']): RunStatus => {
  switch (outcome) {
    case 'created':
    case 'refreshed': {
      return 'changed'
    }
    case 'unchanged': {
      return 'ok'
    }
    case 'skipped-local':
    case 'skipped-platform': {
      return 'skipped'
    }
    case 'failed': {
      return 'fail'
    }
    default: {
      return assertNever(outcome)
    }
  }
}

const portlessLinkDetail = (outcome: PortlessLinkOutcome): string => {
  switch (outcome) {
    case 'created': {
      return 'linked ~/.infra-kit/portless to the running portless'
    }
    case 'repointed': {
      return 're-pointed ~/.infra-kit/portless to the running portless'
    }
    case 'unchanged': {
      return 'already linked to the running portless'
    }
    case 'skipped-local': {
      return 'skipped — this install is not global'
    }
    case 'skipped-unresolved': {
      return 'skipped — portless is not installed'
    }
    case 'failed': {
      return 'could not update the link — see the debug log'
    }
    default: {
      return assertNever(outcome)
    }
  }
}

const portlessNodeDetail = (result: PortlessNodeResult): string => {
  const verb = result.method === 'copy' ? 'copied' : 'linked'

  switch (result.outcome) {
    case 'created': {
      return `${verb} Node ${result.version} to ~/.infra-kit/node`
    }
    case 'refreshed': {
      return `re-${verb} Node ${result.version} to ~/.infra-kit/node`
    }
    case 'unchanged': {
      return `~/.infra-kit/node is already Node ${result.version}`
    }
    case 'skipped-local': {
      return 'skipped — this install is not global'
    }
    case 'skipped-platform': {
      return 'skipped — no portless OS service on this platform'
    }
    case 'failed': {
      return 'could not write ~/.infra-kit/node — see the debug log'
    }
    default: {
      return assertNever(result.outcome)
    }
  }
}

export const serviceRow = (service: ServiceTargetState | 'skipped', command: string | null): RunRow => {
  const name = 'service'

  switch (service) {
    case 'converged': {
      return { name, status: 'ok', message: 'installed service runs through the link and the node' }
    }
    case 'absent': {
      return { name, status: 'manual', message: 'no service installed', notes: command === null ? [] : [command] }
    }
    case 'drifted': {
      return {
        name,
        status: 'manual',
        message: 'installed service is out of date',
        notes: command === null ? [] : [command],
      }
    }
    case 'skipped': {
      return { name, status: 'skipped', message: 'not judged — portless is not installed' }
    }
    default: {
      return assertNever(service)
    }
  }
}

const portlessSection = (portless: SetupReportInput['portless']): RunSection => {
  return {
    label: 'Portless service',
    rows: [
      { name: 'link', status: portlessLinkStatus(portless.link), message: portlessLinkDetail(portless.link) },
      {
        name: 'node',
        status: portlessNodeStatus(portless.node.outcome),
        message: portlessNodeDetail(portless.node),
      },
      serviceRow(portless.service, portless.command),
    ],
  }
}

/**
 * @example
 * toSetupReport({ init, tools, portless }, { skipTools: false })
 * // => [{ label: 'Local setup', rows: [...] }, { label: 'Tools', rows: [...] }, { label: 'Portless service', rows: [...] }]
 */
export const toSetupReport = (input: SetupReportInput, mode: SetupReportMode): RunSection[] => {
  return [initSection(input.init), toolsSection(input.tools, mode), portlessSection(input.portless)]
}

/** The exit rule reads the rows, so the table and the exit code can never disagree. */
export const reportHasFailure = (sections: readonly RunSection[]): boolean => {
  return sections.some((section) => {
    return section.rows.some((row) => {
      return row.status === 'fail'
    })
  })
}
