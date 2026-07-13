import { describe, expect, it } from 'vitest'

import { OPT_OUT_ENV_VARS, autoUpdateSkipReason } from '../guards'
import type { AutoUpdateGuardInput } from '../guards'

/** A globally-installed CLI, run by a human in a TTY: the one shape that MAY auto-update. */
const allowed = (overrides: Partial<AutoUpdateGuardInput> = {}): AutoUpdateGuardInput => {
  return {
    argv: ['node', '/usr/local/lib/node_modules/infra-kit/dist/cli.js', 'version'],
    env: {},
    isTty: true,
    selfRealPath: '/usr/local/lib/node_modules/infra-kit/dist/cli.js',
    cwd: '/Users/me/some-project',
    realpath: (p) => {
      return p
    },
    ...overrides,
  }
}

describe('autoUpdateSkipReason', () => {
  it('permits a global install invoked by a human', () => {
    expect(autoUpdateSkipReason(allowed())).toBeNull()
  })

  it.each(OPT_OUT_ENV_VARS)('skips when %s is set', (name) => {
    expect(autoUpdateSkipReason(allowed({ env: { [name]: '1' } }))).toBe('opt-out')
  })

  it('treats an empty opt-out var as unset', () => {
    expect(autoUpdateSkipReason(allowed({ env: { CI: '' } }))).toBeNull()
  })

  it('skips for --json anywhere in argv, so machine consumers get no chatter', () => {
    expect(autoUpdateSkipReason(allowed({ argv: ['node', 'cli.js', 'version', '--json'] }))).toBe('json')
  })

  it('skips the mcp subcommand, whose stdio carries JSON-RPC framing', () => {
    expect(autoUpdateSkipReason(allowed({ argv: ['node', 'cli.js', 'mcp'] }))).toBe('own-command')
  })

  it('skips self-update, which already performs the update itself', () => {
    // Otherwise `ik self-update` installs interactively AND leaves a worker that installs again.
    expect(autoUpdateSkipReason(allowed({ argv: ['node', 'cli.js', 'self-update'] }))).toBe('own-command')
  })

  it('skips when stdout is not a TTY (piped or scripted)', () => {
    expect(autoUpdateSkipReason(allowed({ isTty: false }))).toBe('not-a-tty')
  })

  it('skips a project-local node_modules install, which pins its own version deliberately', () => {
    expect(
      autoUpdateSkipReason(
        allowed({
          selfRealPath: '/repo/node_modules/infra-kit/dist/cli.js',
          cwd: '/repo',
        }),
      ),
    ).toBe('local-install')
  })

  it('does NOT treat a global pnpm root as a local install (it also has a node_modules segment)', () => {
    expect(
      autoUpdateSkipReason(
        allowed({
          selfRealPath: '/Users/me/Library/pnpm/global/5/node_modules/infra-kit/dist/cli.js',
          cwd: '/Users/me/some-project',
        }),
      ),
    ).toBeNull()
  })

  it('checks opt-out before everything else, so the env var disables the feature outright', () => {
    const input = allowed({ env: { CI: '1' }, argv: ['node', 'cli.js', 'mcp'], isTty: false })

    expect(autoUpdateSkipReason(input)).toBe('opt-out')
  })
})
