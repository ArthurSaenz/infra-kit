import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OperationError } from 'src/lib/errors/operation-error'
import { mcpMode } from 'src/lib/mcp-mode'

import { getMainRepoRoot, getProjectRoot } from '../git-utils'

/**
 * zx mock that (a) records every options object passed to the `$` factory and (b) routes each
 * tagged-template invocation through a swappable `handler`, so a test can make `git rev-parse`
 * resolve or reject at will. `$({ opts })` returns a tag function; mirror that shape exactly.
 */
const zx = vi.hoisted(() => {
  const state = {
    factoryArgs: [] as unknown[],
    handler: (_cmd: string): Promise<{ stdout: string }> => {
      return Promise.resolve({ stdout: '' })
    },
  }

  return { state }
})

vi.mock('zx', () => {
  const $ = (opts?: unknown) => {
    zx.state.factoryArgs.push(opts)

    return (strings: TemplateStringsArray, ...subs: unknown[]): Promise<{ stdout: string }> => {
      const cmd = strings.reduce((acc, s, i) => {
        return `${acc}${s}${i < subs.length ? String(subs[i]) : ''}`
      }, '')

      return zx.state.handler(cmd)
    }
  }

  return { $ }
})

const rejectWith = (value: unknown): void => {
  zx.state.handler = () => {
    return Promise.reject(value)
  }
}

beforeEach(() => {
  zx.state.factoryArgs = []
  zx.state.handler = () => {
    return Promise.resolve({ stdout: '' })
  }
  mcpMode.enabled = false
})

afterEach(() => {
  mcpMode.enabled = false
})

describe('getProjectRoot — honest typed error (Step 1)', () => {
  it('trims the "(or any of the parent directories)" tail for a not-a-git-repository failure', async () => {
    rejectWith({ stderr: 'fatal: not a git repository (or any of the parent directories): .git' })

    const err = await getProjectRoot().catch((e: unknown) => {
      return e
    })

    expect(err).toBeInstanceOf(OperationError)
    expect((err as Error).message).toContain('stderr: not a git repository')
    expect((err as Error).message).not.toContain('or any of the parent directories')
    expect(zx.state.factoryArgs[0]).toEqual({ quiet: true })
  })

  it('passes real dubious-ownership stderr through verbatim and never claims "not a git repository"', async () => {
    const dubious = [
      "fatal: detected dubious ownership in repository at '/Users/me/proj'",
      'To add an exception for this directory, call:',
      '',
      '\tgit config --global --add safe.directory /Users/me/proj',
    ].join('\n')

    rejectWith({ stderr: dubious })

    const err = await getProjectRoot().catch((e: unknown) => {
      return e
    })

    expect(err).toBeInstanceOf(OperationError)
    // buildMessage trims the ends only — a real multi-line stderr may legitimately span lines here.
    expect((err as Error).message).toContain('dubious ownership')
    expect((err as Error).message).not.toContain('not a git repository')
    expect(zx.state.factoryArgs[0]).toEqual({ quiet: true })
  })

  it('passes an EACCES / permission-denied stderr through verbatim', async () => {
    rejectWith({ stderr: 'fatal: could not read Error: Permission denied' })

    const err = await getProjectRoot().catch((e: unknown) => {
      return e
    })

    expect((err as Error).message).toContain('Permission denied')
    expect((err as Error).message).not.toContain('not a git repository')
    expect(zx.state.factoryArgs[0]).toEqual({ quiet: true })
  })

  it('omits the stderr segment AND the stderr-referencing clause when the rejection carries no stderr', async () => {
    // Missing `git` binary / ENOENT: a plain Error with no `.stderr` property (zx's exact ENOENT
    // shape is unverified in this checkout, so assert on the .stderr-less behaviour, not a zx class).
    rejectWith(new Error('spawn git ENOENT'))

    const err = await getProjectRoot().catch((e: unknown) => {
      return e
    })

    expect(err).toBeInstanceOf(OperationError)
    expect((err as Error).message).not.toContain('stderr:')
    expect((err as Error).message).not.toContain('if you are already in one')
    // The base remediation still appears.
    expect((err as Error).message).toContain('run infra-kit from inside an infra-kit project repo')
    expect(zx.state.factoryArgs[0]).toEqual({ quiet: true })
  })

  it('treats an empty-string stderr as missing (same as no stderr at all)', async () => {
    rejectWith({ stderr: '' })

    const err = await getProjectRoot().catch((e: unknown) => {
      return e
    })

    expect((err as Error).message).not.toContain('stderr:')
    expect((err as Error).message).not.toContain('if you are already in one')
    expect(zx.state.factoryArgs[0]).toEqual({ quiet: true })
  })

  it('mCP remediation redirects to the operator and names neither `cd ` nor `--project` (Step 3)', async () => {
    mcpMode.enabled = true
    rejectWith({ stderr: 'fatal: not a git repository (or any of the parent directories): .git' })

    const err = await getProjectRoot().catch((e: unknown) => {
      return e
    })

    const message = (err as Error).message

    expect(message).toContain('the infra-kit MCP server resolves its project from the working directory')
    expect(message).not.toContain('cd ')
    expect(message).not.toContain('--project')
  })
})

describe('getMainRepoRoot — quiet MERGE keeps cwd (§1.5)', () => {
  it('passes BOTH cwd (the root argument) and quiet:true to the --git-common-dir factory', async () => {
    zx.state.handler = () => {
      return Promise.resolve({ stdout: '.git' })
    }

    await expect(getMainRepoRoot('/some/root')).resolves.toBe('/some/root')

    // Asserting only { quiet: true } would pass on the broken `$({ quiet: true })` form — require cwd too.
    expect(zx.state.factoryArgs).toContainEqual(expect.objectContaining({ cwd: '/some/root', quiet: true }))
  })

  it('does NOT wrap a genuine git failure in OperationError — the raw cause propagates', async () => {
    const raw = new Error('boom: --git-common-dir exploded')

    rejectWith(raw)

    const err = await getMainRepoRoot('/some/root').catch((e: unknown) => {
      return e
    })

    expect(err).toBe(raw)
    expect(err).not.toBeInstanceOf(OperationError)
  })
})
