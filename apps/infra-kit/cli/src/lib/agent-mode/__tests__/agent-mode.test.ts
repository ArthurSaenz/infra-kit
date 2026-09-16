import { afterEach, describe, expect, it } from 'vitest'

import { jsonOutput } from 'src/lib/json-output'

import { agentMode, isAgentMode, isHeadless, resolveAgentModeSource } from '../agent-mode'
import type { AgentModeSource } from '../agent-mode'

afterEach(() => {
  agentMode.source = null
})

/**
 * The §3.1 precedence table, one row per case. `stdinIsTTY` and `INFRA_KIT_AGENT` are the two
 * axes an operator can move without meaning to — an inherited `CLAUDECODE` in a human's terminal,
 * a stray `INFRA_KIT_AGENT=0` in `.zshenv` — so every cell is pinned rather than the boundaries.
 */
const TABLE: {
  label: string
  flag: boolean
  agentVar: string | undefined
  claudeCode: string | undefined
  stdinIsTTY: boolean
  expected: AgentModeSource
}[] = [
  {
    label: '--agent beats INFRA_KIT_AGENT=0',
    flag: true,
    agentVar: '0',
    claudeCode: '1',
    stdinIsTTY: true,
    expected: 'flag',
  },
  {
    label: '--agent beats INFRA_KIT_AGENT=0 off a TTY too',
    flag: true,
    agentVar: '0',
    claudeCode: undefined,
    stdinIsTTY: false,
    expected: 'flag',
  },
  {
    label: '--agent with the variable unset',
    flag: true,
    agentVar: undefined,
    claudeCode: undefined,
    stdinIsTTY: true,
    expected: 'flag',
  },
  {
    label: '--agent with INFRA_KIT_AGENT=1',
    flag: true,
    agentVar: '1',
    claudeCode: undefined,
    stdinIsTTY: false,
    expected: 'flag',
  },
  {
    label: 'INFRA_KIT_AGENT=1 on a TTY',
    flag: false,
    agentVar: '1',
    claudeCode: undefined,
    stdinIsTTY: true,
    expected: 'env',
  },
  {
    label: 'INFRA_KIT_AGENT=1 off a TTY',
    flag: false,
    agentVar: '1',
    claudeCode: '1',
    stdinIsTTY: false,
    expected: 'env',
  },
  {
    label: 'INFRA_KIT_AGENT=0 suppresses the CLAUDECODE heuristic',
    flag: false,
    agentVar: '0',
    claudeCode: '1',
    stdinIsTTY: false,
    expected: null,
  },
  {
    label: 'CLAUDECODE off a TTY',
    flag: false,
    agentVar: undefined,
    claudeCode: '1',
    stdinIsTTY: false,
    expected: 'env',
  },
  {
    label: 'CLAUDECODE off a TTY with an ignored INFRA_KIT_AGENT value',
    flag: false,
    agentVar: 'other',
    claudeCode: '1',
    stdinIsTTY: false,
    expected: 'env',
  },
  {
    label: 'CLAUDECODE on a TTY is a human (Orca, Zed)',
    flag: false,
    agentVar: undefined,
    claudeCode: '1',
    stdinIsTTY: true,
    expected: null,
  },
  {
    label: 'nothing set on a TTY',
    flag: false,
    agentVar: undefined,
    claudeCode: undefined,
    stdinIsTTY: true,
    expected: null,
  },
  {
    label: 'nothing set off a TTY (a piped-but-human run)',
    flag: false,
    agentVar: undefined,
    claudeCode: undefined,
    stdinIsTTY: false,
    expected: null,
  },
]

describe('resolveAgentModeSource — the §3.1 precedence table', () => {
  it.each(TABLE)('$label → $expected', ({ flag, agentVar, claudeCode, stdinIsTTY, expected }) => {
    const env: NodeJS.ProcessEnv = {}

    if (agentVar !== undefined) env.INFRA_KIT_AGENT = agentVar
    if (claudeCode !== undefined) env.CLAUDECODE = claudeCode

    expect(resolveAgentModeSource({ env, stdinIsTTY, flag })).toBe(expected)
  })

  it('treats CLAUDECODE as set even when empty — presence is the signal, not the value', () => {
    expect(resolveAgentModeSource({ env: { CLAUDECODE: '' }, stdinIsTTY: false, flag: false })).toBe('env')
  })

  it('ignores every INFRA_KIT_AGENT value but "1" and "0"', () => {
    // A value outside the domain is treated as unset: it neither enables nor suppresses. Both
    // halves are asserted, because "ignored" that only holds on one side is a third value.
    for (const value of ['true', 'yes', '2', '', 'agent']) {
      expect(resolveAgentModeSource({ env: { INFRA_KIT_AGENT: value }, stdinIsTTY: true, flag: false })).toBeNull()
      expect(
        resolveAgentModeSource({ env: { INFRA_KIT_AGENT: value, CLAUDECODE: '1' }, stdinIsTTY: false, flag: false }),
      ).toBe('env')
    }
  })
})

describe('agentMode holder', () => {
  it('isAgentMode is true for every non-null source and false for null', () => {
    expect(isAgentMode()).toBe(false)

    for (const source of ['flag', 'env'] as const) {
      agentMode.source = source

      expect(isAgentMode()).toBe(true)
    }

    agentMode.source = null

    expect(isAgentMode()).toBe(false)
  })

  it('isHeadless is true for any agent source and for --json alone, false for a human without --json', () => {
    expect(isHeadless()).toBe(false)

    jsonOutput.enabled = true

    expect(isHeadless()).toBe(true)

    jsonOutput.enabled = false
    agentMode.source = 'env'

    expect(isHeadless()).toBe(true)
  })
})
