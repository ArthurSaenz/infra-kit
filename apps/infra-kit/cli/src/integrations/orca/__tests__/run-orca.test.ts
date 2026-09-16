import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OrcaAbsentError, OrcaError, OrcaMalformedError, runOrca } from '../run-orca'
import { absent, fail, ok, orcaCli } from './orca-cli-mock'

vi.mock('zx', async () => {
  return (await import('./orca-cli-mock')).zxModule
})

describe('runOrca', () => {
  beforeEach(() => {
    orcaCli.reset()
  })

  it('appends --json and returns result on ok:true', async () => {
    orcaCli.respond = () => {
      return ok({ app: { running: true } })
    }

    await expect(runOrca(['status'])).resolves.toEqual({ app: { running: true } })
    expect(orcaCli.calls).toEqual([['status']])
  })

  it('throws OrcaError carrying code/message/data on ok:false with exit 1', async () => {
    orcaCli.respond = () => {
      return fail('selector_not_found', 'no such worktree', 1, { validSelectorForms: ['path:'] })
    }

    const error = await runOrca(['worktree', 'show']).catch((thrown: unknown) => {
      return thrown
    })

    expect(error).toBeInstanceOf(OrcaError)
    expect(error).toMatchObject({
      code: 'selector_not_found',
      message: 'no such worktree',
      data: { validSelectorForms: ['path:'] },
    })
  })

  it('throws OrcaError on ok:false even when the exit code is 0 (1.4.203 convention)', async () => {
    orcaCli.respond = () => {
      return fail('runtime_error', 'boom', 0)
    }

    await expect(runOrca(['status'])).rejects.toBeInstanceOf(OrcaError)
  })

  it('throws OrcaMalformedError with exit code and stderr tail when stdout is not an envelope', async () => {
    orcaCli.respond = () => {
      return { exitCode: 1, stdout: 'Usage: orca <command>', stderr: 'unknown flag --json' }
    }

    const error = await runOrca(['status']).catch((thrown: unknown) => {
      return thrown
    })

    expect(error).toBeInstanceOf(OrcaMalformedError)
    expect(error).toMatchObject({ exitCode: 1, stderrTail: 'unknown flag --json' })
  })

  it('treats a JSON stdout without an ok field as malformed', async () => {
    orcaCli.respond = () => {
      return { exitCode: 0, stdout: '{"result":{}}' }
    }

    await expect(runOrca(['status'])).rejects.toBeInstanceOf(OrcaMalformedError)
  })

  it('throws OrcaAbsentError on the shell exit 127 shape', async () => {
    orcaCli.respond = absent

    await expect(runOrca(['status'])).rejects.toBeInstanceOf(OrcaAbsentError)
  })

  it('throws OrcaAbsentError when the spawn itself rejects with ENOENT', async () => {
    orcaCli.respond = () => {
      return { reject: Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' }) }
    }

    await expect(runOrca(['status'])).rejects.toBeInstanceOf(OrcaAbsentError)
  })

  it('re-throws a non-ENOENT spawn failure untouched', async () => {
    const boom = new Error('EACCES')

    orcaCli.respond = () => {
      return { reject: boom }
    }

    await expect(runOrca(['status'])).rejects.toBe(boom)
  })
})
