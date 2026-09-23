import { describe, expect, it } from 'vitest'

import type { ServiceTargetState } from 'src/commands/doctor/doctor'
import { SHELL_ACTIVATION_REMINDER } from 'src/commands/init/init'
import type { InitEntry, InitOutcome } from 'src/commands/init/init'
import type { PortlessLinkOutcome } from 'src/dev/proxy/portless-link'
import type { PortlessNodeOutcome, PortlessNodeResult } from 'src/dev/proxy/portless-node'
import type { RunRow, RunSection, RunStatus } from 'src/lib/render/run-report'

import type { ToolResult } from '../converge'
import {
  INIT_STEPS,
  initEntryStatus,
  portlessLinkStatus,
  portlessNodeStatus,
  reportHasFailure,
  serviceRow,
  toSetupReport,
  toolStatus,
  worstStatus,
} from '../report'
import type { SetupReportInput } from '../report'

/**
 * The pure mapping from `setup`'s three vocabularies onto the report's one. Every table below is a
 * `Record` over the source type, so a new member fails `ts-check` here as well as `assertNever` in
 * the mapper, and fails the test until someone decides what it looks like in the table.
 */

const INIT_OUTCOMES: Record<InitOutcome, RunStatus> = {
  written: 'changed',
  unchanged: 'ok',
  skipped: 'skipped',
  manual: 'manual',
  warned: 'warn',
  failed: 'fail',
}

const TOOL_ACTIONS: Record<ToolResult['action'], RunStatus> = {
  installed: 'changed',
  updated: 'changed',
  skipped: 'skipped',
  refused: 'manual',
  failed: 'fail',
}

const LINK_OUTCOMES: Record<PortlessLinkOutcome, RunStatus> = {
  created: 'changed',
  repointed: 'changed',
  unchanged: 'ok',
  'skipped-local': 'skipped',
  'skipped-unresolved': 'skipped',
  failed: 'fail',
}

const NODE_OUTCOMES: Record<PortlessNodeOutcome, RunStatus> = {
  created: 'changed',
  refreshed: 'changed',
  unchanged: 'ok',
  'skipped-local': 'skipped',
  'skipped-platform': 'skipped',
  failed: 'fail',
}

const SERVICE_STATES: Record<ServiceTargetState | 'skipped', RunStatus> = {
  converged: 'ok',
  absent: 'manual',
  drifted: 'manual',
  skipped: 'skipped',
}

const SUDO = 'sudo /Users/ada/.infra-kit/node /Users/ada/.infra-kit/portless/dist/cli.js service install'

const entry = (over: Partial<InitEntry> = {}): InitEntry => {
  return { step: 'guidance', outcome: 'written', message: 'Wrote CLAUDE.md', level: 'info', ...over }
}

const tool = (over: Partial<ToolResult> = {}): ToolResult => {
  return {
    id: 'aws',
    action: 'refused',
    before: { present: false, onPath: false, version: null, manager: 'none' },
    commands: ['curl -fsSL https://example.test/install.sh | sh'],
    detail: 'refused (needs-sudo) — run the commands printed below yourself',
    ...over,
  }
}

const nodeResult = (outcome: PortlessNodeOutcome): PortlessNodeResult => {
  return { kind: 'node', outcome, node: '/n', source: '/s', version: 'v24.0.0', method: 'hardlink' }
}

const input = (over: Partial<SetupReportInput> = {}): SetupReportInput => {
  return {
    init: [],
    tools: [],
    portless: { link: 'unchanged', node: nodeResult('unchanged'), service: 'converged', command: null },
    ...over,
  }
}

const section = (sections: RunSection[], label: string): RunSection | undefined => {
  return sections.find((candidate) => {
    return candidate.label === label
  })
}

const initRow = (entries: InitEntry[], step: InitEntry['step'] = 'guidance'): RunRow | undefined => {
  return section(toSetupReport(input({ init: entries }), { skipTools: false }), 'Local setup')?.rows.find((row) => {
    return row.name === step
  })
}

describe('every source vocabulary maps onto exactly one row status', () => {
  it.each(Object.entries(INIT_OUTCOMES))('init %s → %s', (outcome, status) => {
    expect(initEntryStatus(outcome as InitOutcome)).toBe(status)
  })

  it.each(Object.entries(TOOL_ACTIONS))('tool %s → %s', (action, status) => {
    expect(toolStatus(tool({ action: action as ToolResult['action'] }), { skipTools: false })).toBe(status)
  })

  it.each(Object.entries(LINK_OUTCOMES))('portless link %s → %s', (outcome, status) => {
    expect(portlessLinkStatus(outcome as PortlessLinkOutcome)).toBe(status)
  })

  it.each(Object.entries(NODE_OUTCOMES))('portless node %s → %s', (outcome, status) => {
    expect(portlessNodeStatus(outcome as PortlessNodeOutcome)).toBe(status)
  })

  it.each(Object.entries(SERVICE_STATES))('portless service %s → %s', (state, status) => {
    expect(serviceRow(state as ServiceTargetState | 'skipped', SUDO).status).toBe(status)
  })
})

describe('an init step row takes the worst status among its entries', () => {
  // One case per adjacent pair of the ranking `fail > warn > manual > changed > ok > skipped`.
  it.each<[RunStatus, RunStatus]>([
    ['fail', 'warn'],
    ['warn', 'manual'],
    ['manual', 'changed'],
    ['changed', 'ok'],
    ['ok', 'skipped'],
  ])('%s outranks %s', (worse, better) => {
    expect(worstStatus([better, worse])).toBe(worse)
    expect(worstStatus([worse, better])).toBe(worse)
  })

  // Reds on: a step that wrote something AND still needs a human command reading as done.
  it('shows a step that wrote and still needs a human as manual', () => {
    expect(initRow([entry(), entry({ outcome: 'manual', message: 'claude plugin install x' })])?.status).toBe('manual')
  })

  it('emits one row per init step, in run order, and a step with no entries as did-not-run', () => {
    const rows = section(
      toSetupReport(input({ init: [entry({ step: 'zshrc' })] }), { skipTools: false }),
      'Local setup',
    )?.rows

    expect(
      rows?.map((row) => {
        return row.name
      }),
    ).toEqual(INIT_STEPS)
    expect(rows?.[1]).toEqual({ name: 'zshenv', status: 'skipped', message: 'did not run' })
  })
})

describe('notes are chosen by mapped status, never by pino level', () => {
  // Reds on: selecting notes by `level === 'warn'`, which loses the info-level plugin commands.
  it('turns an info-level manual entry into a note', () => {
    const row = initRow(
      [entry({ step: 'plugin-pointer', outcome: 'manual', message: 'claude plugin install x', level: 'info' })],
      'plugin-pointer',
    )

    expect(row?.notes).toEqual(['claude plugin install x'])
  })

  // Reds on: the reverse mistake, a warn-level entry that ran cleanly becoming a note.
  it('does not turn a warn-level ok entry into a note', () => {
    const row = initRow([entry({ outcome: 'unchanged', message: 'nothing to do', level: 'warn' })])

    expect(row).toEqual({ name: 'guidance', status: 'ok', message: 'nothing to do' })
  })

  it('never counts a manual, warn or fail entry in the summary', () => {
    const row = initRow([
      entry(),
      entry(),
      entry({ outcome: 'unchanged' }),
      entry({ outcome: 'manual', message: 'run me' }),
      entry({ outcome: 'warned', message: 'careful' }),
      entry({ outcome: 'failed', message: 'broke' }),
    ])

    expect(row).toEqual({
      name: 'guidance',
      status: 'fail',
      message: '2 written · 1 unchanged',
      notes: ['run me', 'careful', 'broke'],
    })
  })

  it('uses a single summarised entry’s own text, and a fixed message when only notes remain', () => {
    expect(initRow([entry({ message: 'Wrote CLAUDE.md' })])?.message).toBe('Wrote CLAUDE.md')
    expect(initRow([entry({ outcome: 'warned', message: 'careful' })])).toEqual({
      name: 'guidance',
      status: 'warn',
      message: 'see below',
      notes: ['careful'],
    })
  })

  // Reds on: repeating the activation reminder in the shell row as well as on the last line.
  it('keeps the activation reminder out of the shell row', () => {
    const row = initRow([entry({ step: 'shell', outcome: 'unchanged', message: SHELL_ACTIVATION_REMINDER })], 'shell')

    expect(row).toEqual({ name: 'shell', status: 'ok', message: 'activate with the last line below' })
  })
})

describe('tools', () => {
  it('reports a refusal as manual with its argv as notes', () => {
    const rows = section(toSetupReport(input({ tools: [tool()] }), { skipTools: false }), 'Tools')?.rows

    expect(rows).toEqual([
      {
        name: 'aws',
        status: 'manual',
        message: 'refused (needs-sudo) — run the commands printed below yourself',
        notes: ['curl -fsSL https://example.test/install.sh | sh'],
      },
    ])
  })

  it('labels the probe, and makes a probe skip that carries argv manual', () => {
    const tools = [
      tool({
        id: 'doppler',
        action: 'skipped',
        commands: ['brew install dopplerhq/cli/doppler'],
        detail: 'would install',
      }),
      tool({ id: 'git', action: 'skipped', commands: [], detail: 'nothing to do' }),
    ]
    const probe = section(toSetupReport(input({ tools }), { skipTools: true }), 'Tools (probe: nothing installed)')

    expect(probe?.rows).toEqual([
      { name: 'doppler', status: 'manual', message: 'would install', notes: ['brew install dopplerhq/cli/doppler'] },
      { name: 'git', status: 'skipped', message: 'nothing to do' },
    ])
  })

  it('keeps a converge skip with argv as skipped', () => {
    expect(toolStatus(tool({ action: 'skipped' }), { skipTools: false })).toBe('skipped')
  })
})

describe('portless service', () => {
  it.each<[ServiceTargetState, string]>([
    ['absent', 'no service installed'],
    ['drifted', 'installed service is out of date'],
  ])('reports %s as manual, naming which, with the sudo command as the one note', (state, message) => {
    expect(serviceRow(state, SUDO)).toEqual({ name: 'service', status: 'manual', message, notes: [SUDO] })
  })

  it('draws link, node and service rows under one section', () => {
    const rows = section(toSetupReport(input(), { skipTools: false }), 'Portless service')?.rows

    expect(
      rows?.map((row) => {
        return [row.name, row.status]
      }),
    ).toEqual([
      ['link', 'ok'],
      ['node', 'ok'],
      ['service', 'ok'],
    ])
  })
})

describe('only a fail row fails the run', () => {
  it('ignores manual, warn, skipped and changed rows', () => {
    const report = toSetupReport(
      input({
        init: [entry({ outcome: 'manual' }), entry({ step: 'shell', outcome: 'warned', message: 'not zsh' })],
        tools: [tool()],
        portless: { link: 'created', node: nodeResult('skipped-local'), service: 'absent', command: SUDO },
      }),
      { skipTools: false },
    )

    expect(reportHasFailure(report)).toBe(false)
  })

  it('fails on a portless link failure, which the old tools-only rule missed', () => {
    const report = toSetupReport(
      input({ portless: { link: 'failed', node: nodeResult('unchanged'), service: 'skipped', command: null } }),
      {
        skipTools: false,
      },
    )

    expect(reportHasFailure(report)).toBe(true)
  })
})
