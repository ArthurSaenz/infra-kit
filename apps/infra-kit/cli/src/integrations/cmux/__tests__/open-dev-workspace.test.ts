import { beforeEach, describe, expect, it, vi } from 'vitest'

import { closeCmuxDevWorkspace, isCmuxAvailable, openCmuxDevWorkspace } from '../open-dev-workspace'

/**
 * Shell-facing cmux dev-workspace helpers. `zx`'s `$` is mocked to route on the
 * command text, covering both the plain `` $`cmd` `` form and the scoped
 * `$({ env })` form `openCmuxDevWorkspace` uses to set `CMUX_QUIET=1`.
 */
const state = vi.hoisted(() => {
  return { versionFails: false, newWorkspaceOut: 'OK workspace:5\n' }
})

vi.mock('zx', () => {
  function makeResult(stdout: string) {
    return Object.assign(Promise.resolve({ stdout }), {
      quiet: () => {
        return Promise.resolve({ stdout })
      },
    })
  }

  function makeRejecting() {
    // Base resolves (so there's no unhandled rejection) but `.quiet()` rejects,
    // matching how a missing `cmux --version` would fail under `await …quiet()`.
    return Object.assign(Promise.resolve({ stdout: '' }), {
      quiet: () => {
        return Promise.reject(new Error('cmux: command not found'))
      },
    })
  }

  const tag = (strings: TemplateStringsArray): ReturnType<typeof makeResult> => {
    const cmd = strings.join('')

    if (cmd.includes('--version')) {
      return state.versionFails ? makeRejecting() : makeResult('cmux 1.0.0\n')
    }
    if (cmd.includes('new-workspace')) return makeResult(state.newWorkspaceOut)

    return makeResult('')
  }

  const $ = vi.fn((first: unknown) => {
    // Tagged-template form: first arg is the strings array.
    if (Array.isArray(first)) {
      return tag(first as unknown as TemplateStringsArray)
    }

    // Options form `$({ env })`: returns a scoped tagged-template function.
    return tag
  })

  return { $ }
})

const LAYOUT = { pane: { surfaces: [{ type: 'terminal' as const, command: 'echo hi' }] } }
const WORKSPACE_CWD = '/home/dev/repo'

describe('isCmuxAvailable', () => {
  beforeEach(() => {
    state.versionFails = false
  })

  it('returns true when `cmux --version` resolves', async () => {
    expect(await isCmuxAvailable()).toBe(true)
  })

  it('returns false when `cmux --version` throws', async () => {
    state.versionFails = true

    expect(await isCmuxAvailable()).toBe(false)
  })
})

describe('openCmuxDevWorkspace', () => {
  beforeEach(() => {
    state.newWorkspaceOut = 'OK workspace:5\n'
  })

  it('parses and returns the workspace ref from new-workspace output', async () => {
    const ref = await openCmuxDevWorkspace({ cwd: WORKSPACE_CWD, title: 'repo dev', layout: LAYOUT })

    expect(ref).toBe('workspace:5')
  })

  it('throws when the output carries no workspace ref', async () => {
    state.newWorkspaceOut = 'something went wrong\n'

    await expect(openCmuxDevWorkspace({ cwd: WORKSPACE_CWD, title: 'repo dev', layout: LAYOUT })).rejects.toThrow(
      /could not locate workspace ref/,
    )
  })
})

describe('closeCmuxDevWorkspace', () => {
  it('resolves without throwing (best-effort close)', async () => {
    await expect(closeCmuxDevWorkspace('workspace:5')).resolves.toBeUndefined()
  })
})
