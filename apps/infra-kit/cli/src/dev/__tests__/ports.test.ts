import { describe, expect, it } from 'vitest'

import { findPortConflicts, parsePortString, resolvePreferredPort } from 'src/dev/ports'

/**
 * Pure port resolution. Every function is side-effect free, so these
 * specs pass `env` in as a plain object — no fixtures, no cwd,
 * no process.env mutation.
 */
describe('resolvePreferredPort — explicit-only (no DEFAULT_PORT fallback)', () => {
  it('returns undefined when nothing is explicitly configured (no DEFAULT_PORT fallback)', () => {
    expect(resolvePreferredPort('client', {})).toBeUndefined()
  })

  it('lets {APP}_PORT take precedence over PORT', () => {
    expect(resolvePreferredPort('client', { PORT: '3300' })).toBe(3300)
    expect(resolvePreferredPort('client', { PORT: '3300', CLIENT_PORT: '3400' })).toBe(3400)
  })

  it('preserves an explicit {APP}_PORT = 0 (ephemeral request), not undefined', () => {
    expect(resolvePreferredPort('client', { CLIENT_PORT: '0' })).toBe(0)
  })

  it('maps a hyphenated app name to UPPER_SNAKE_CASE for the {APP}_PORT key', () => {
    expect(resolvePreferredPort('search-engine', { SEARCH_ENGINE_PORT: '3500' })).toBe(3500)
  })

  it('strips surrounding quotes on a {APP}_PORT env value', () => {
    // Secrets managers can export values wrapped in quotes.
    expect(resolvePreferredPort('client', { CLIENT_PORT: '"3400"' })).toBe(3400)
  })
})

/**
 * The bare `PORT` tier is the only one that is not app-scoped, so in a multi-app run it hands every
 * app the same value and the caller's conflict gate then refuses to start over duplicates the
 * environment manufactured. `allowBarePort` is how the caller declines that tier once it knows more
 * than one app is launching; nothing else about the precedence changes.
 */
describe('resolvePreferredPort — allowBarePort gates ONLY the bare PORT tier', () => {
  it('drops a bare PORT when denied, and keeps it when allowed or omitted', () => {
    expect(resolvePreferredPort('client', { PORT: '3300' }, false)).toBeUndefined()
    expect(resolvePreferredPort('client', { PORT: '3300' }, true)).toBe(3300)
    expect(resolvePreferredPort('client', { PORT: '3300' })).toBe(3300)
  })

  it('leaves the per-app {APP}_PORT tier untouched when the bare tier is denied', () => {
    expect(resolvePreferredPort('client', { PORT: '3300', CLIENT_PORT: '3400' }, false)).toBe(3400)
  })
})

describe('parsePortString — raw port coercion', () => {
  it('strips a single pair of surrounding quotes', () => {
    expect(parsePortString('"3400"')).toBe(3400)
    expect(parsePortString("'3400'")).toBe(3400)
  })

  it('returns undefined for non-numeric input', () => {
    expect(parsePortString('abc')).toBeUndefined()
  })

  it('returns undefined for undefined and blank input', () => {
    expect(parsePortString(undefined)).toBeUndefined()
    expect(parsePortString('')).toBeUndefined()
  })
})

describe('findPortConflicts — duplicate detection', () => {
  it('reports the duplicate port and every colliding app when two apps share a port', () => {
    const result = findPortConflicts([
      { name: 'client', port: 3010 },
      { name: 'backoffice', port: 3010 },
    ])

    expect(result.duplicatePorts).toEqual([3010])
    expect(result.conflictingApps).toEqual([
      { name: 'client', port: 3010 },
      { name: 'backoffice', port: 3010 },
    ])
  })

  it('reports no conflict when every app resolves to a distinct port', () => {
    const result = findPortConflicts([
      { name: 'client', port: 3010 },
      { name: 'backoffice', port: 3011 },
    ])

    expect(result.duplicatePorts).toEqual([])
    expect(result.conflictingApps).toEqual([])
  })
})
