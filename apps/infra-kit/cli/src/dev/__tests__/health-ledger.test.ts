import { describe, expect, it } from 'vitest'

import { HealthLedger } from '../health-ledger'

const ledger = (): { health: HealthLedger; logs: string[] } => {
  const logs: string[] = []

  return {
    health: new HealthLedger((message) => {
      logs.push(message)
    }),
    logs,
  }
}

const api = { tag: 'shop/api', port: 1, kind: 'api' as const }
const ui = { tag: 'shop/ui', port: 2, kind: 'ui' as const }

describe('healthLedger', () => {
  it('reports a tag it was never told about as unknown', () => {
    expect(ledger().health.stateOf('shop/api')).toBe('unknown')
  })

  it('holds a backend at ok until the failure threshold, then announces down once and recovery once', () => {
    const { health, logs } = ledger()

    health.record(api, 'ok')
    health.record(api, 'refused')

    expect(health.stateOf(api.tag)).toBe('ok')

    health.record(api, 'refused')
    health.record(api, 'refused')

    expect(health.stateOf(api.tag)).toBe('down')

    health.record(api, 'ok')

    expect(health.stateOf(api.tag)).toBe('ok')
    expect(logs).toEqual(['⚠️  shop/api unhealthy (/__health not responding)', '✅ shop/api recovered'])
  })

  it('keeps a frontend that was never up at starting until the never-up budget is spent', () => {
    const { health } = ledger()

    health.track(ui.tag, 'ui')

    for (let probe = 1; probe < HealthLedger.NEVER_UP_DOWN_THRESHOLD; probe += 1) health.record(ui, 'refused')

    expect(health.stateOf(ui.tag)).toBe('starting')

    health.record(ui, 'refused')

    expect(health.stateOf(ui.tag)).toBe('down')
  })

  it('reads a never-up backend as down on sight, and a marked-dead frontend as down without a probe', () => {
    const { health } = ledger()

    health.track(api.tag, 'api')
    health.track(ui.tag, 'ui')

    expect(health.stateOf(api.tag)).toBe('down')
    expect(health.stateOf(ui.tag)).toBe('starting')

    health.markDead(ui.tag, 'ui')

    expect(health.stateOf(ui.tag)).toBe('down')
  })

  it('declares a row down without probes through markDown, even one that had been up', () => {
    const { health } = ledger()

    health.record(api, 'ok')
    health.markDown(api.tag, 'api')

    expect(health.stateOf(api.tag)).toBe('down')
  })
})
