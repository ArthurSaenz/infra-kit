import { describe, expect, it } from 'vitest'

import { parseTeeLines } from '../stdio-tee'

/**
 * The committed control on `servedConnection()`'s selector.
 *
 * WHY THIS FILE EXISTS. The runtime `throw` in the selector is a guard, not a test, and it does NOT
 * fire on the failure mode that matters: a revert to a "pid with the most frames" heuristic. In the
 * modern lane that heuristic ties two-to-two — the disposable sibling carries a `server/discover`
 * request plus its result, and the served connection carries only the test's own `tools/list`
 * request plus its result. The tie resolves nondeterministically, and when it picks the sibling the
 * modern-encoding assertions still PASS, because `server/discover`'s own result is modern-encoded.
 * Only a whole-object comparison would notice, and it would read like a differential bug rather
 * than a pid-selection bug.
 *
 * These are pure functions over a synthetic two-pid log: no spawn, no build, no filesystem.
 */

const teeLine = (marker: '>' | '<', pid: number, frame: Record<string, unknown>): string => {
  return `${marker}${pid}\t${JSON.stringify(frame)}`
}

const discoverRequest = { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }
const discoverResult = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-07-28' } }
const toolsListRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
const toolsListResult = { jsonrpc: '2.0', id: 1, result: { tools: [] } }

describe('stdio-tee servedConnection', () => {
  it('t1a — returns the pid that never issued server/discover', () => {
    const log = parseTeeLines([
      teeLine('>', 1, discoverRequest),
      teeLine('<', 1, discoverResult),
      teeLine('>', 2, toolsListRequest),
      teeLine('<', 2, toolsListResult),
    ])

    const served = log.servedConnection()

    expect(served.pid).toBe(2)
    expect(served.inbound).toEqual([toolsListRequest])
    expect(served.outbound).toEqual([toolsListResult])
    expect(log.byPid.size).toBe(2)
  })

  it('t1b(i) — throws when two pids are served candidates', () => {
    const log = parseTeeLines([
      teeLine('>', 2, toolsListRequest),
      teeLine('<', 2, toolsListResult),
      teeLine('>', 3, toolsListRequest),
      teeLine('<', 3, toolsListResult),
    ])

    expect(() => {
      return log.servedConnection()
    }).toThrow(/expected exactly one served connection, found 2/)
    expect(() => {
      return log.servedConnection()
    }).toThrow(/served pids: \[2, 3\]/)
  })

  it('t1b(ii) — throws when every pid is a negotiation sibling', () => {
    const log = parseTeeLines([teeLine('>', 1, discoverRequest), teeLine('<', 1, discoverResult)])

    expect(() => {
      return log.servedConnection()
    }).toThrow(/expected exactly one served connection, found 0/)
    expect(() => {
      return log.servedConnection()
    }).toThrow(/Sibling pids \(issued a 'server\/discover' request\): \[1\]/)
  })

  it('t1c — skips unparsable lines and counts them instead of throwing', () => {
    const log = parseTeeLines([
      'this is not a tee record',
      `>2\tnot json`,
      `>2\t[1,2,3]`,
      teeLine('>', 2, toolsListRequest),
      teeLine('<', 2, toolsListResult),
      '',
    ])

    expect(log.malformed).toBe(3)
    expect(log.servedConnection().pid).toBe(2)
  })
})
