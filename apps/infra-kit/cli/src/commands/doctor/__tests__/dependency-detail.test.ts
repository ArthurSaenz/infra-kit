import { describe, expect, it, vi } from 'vitest'

import { commandCatalog } from 'src/lib/command-catalog'
import type { ProbeDeps } from 'src/lib/dependency-probe'
import { DEPENDENCY_IDS } from 'src/lib/dependency-registry'
import type { DependencyId } from 'src/lib/dependency-registry'

import { doctor } from '../doctor'

/**
 * @fileoverview
 * U-D3 / I-2 — the probe's report rides as an optional `detail` on the row that already answers "is
 * this tool installed", so an agent asking that question reads ONE list.
 *
 * The alternative rejected here was a sibling `dependencies[]` array. It is a second copy of a list
 * `doctor` already owns, with semantics documented to disagree: the row passes iff the binary resolves
 * ON PATH, while the probe reports `present` and `onPath` separately — and the AWS-documented installer
 * writes `$HOME/.local/bin`, so `aws` can be `status: 'fail'` and `present: true` in one response with
 * no tie-break rule. That disagreement is asserted below rather than merely described.
 */

/** Where a brew-owned binary lives, in the one shape `isBrewKegOf` recognises. */
const cellarBin = (keg: string, version: string, bin: string): string => {
  return `/opt/homebrew/Cellar/${keg}/${version}/bin/${bin}`
}

/**
 * `gh` and `brew` on PATH from a brew keg; `doppler` absent entirely; `aws` installed by the AWS
 * script into `$HOME/.local/bin` and NOT on PATH — the split-brain case the whole `present`/`onPath`
 * distinction exists for.
 */
const mixedInstall = (): ProbeDeps => {
  const onPath: Record<string, string> = {
    brew: cellarBin('brew', '4.4.0', 'brew'),
    gh: cellarBin('gh', '2.62.0', 'gh'),
  }
  const versions: Record<string, string> = { brew: '4.4.0', gh: '2.62.0', aws: '2.19.5' }

  return {
    runCommand: (argv) => {
      // An absolute-path re-run is how the probe gets a version for a `present && !onPath` tool; the
      // binary name is the last segment either way.
      const bin = (argv[0] ?? '').split('/').pop() ?? ''
      const reachable = bin in onPath || argv[0]?.startsWith('/') === true
      const version = versions[bin]

      if (!reachable || version === undefined) return Promise.reject(new Error('exit 127'))

      return Promise.resolve({ stdout: `${bin} version ${version}` })
    },
    resolveBinPath: (binName) => {
      // The installer's own layout — `~/.local/share/aws-cli/...`, owned by no package manager, which
      // is what makes `manager: 'script'` the right answer rather than `unknown`.
      if (binName === 'aws') return Promise.resolve('/home/u/.local/share/aws-cli/v2/current/bin/aws')

      return Promise.resolve(onPath[binName] ?? null)
    },
    realpath: (p) => {
      return p
    },
    platform: 'darwin',
  }
}

vi.mock('src/lib/env-tokens', () => {
  return {
    getTokenStorePath: vi.fn(() => {
      return Promise.resolve('/nowhere/tokens.json')
    }),
    readTokenStore: vi.fn(() => {
      return Promise.resolve({ version: 1, envs: {} })
    }),
  }
})

// Partial — `env-load` pulls its own constants off this barrel, so a wholesale replacement breaks the
// import graph before a single check runs.
vi.mock('src/integrations/doppler', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('src/integrations/doppler')>()),
    resolveEnvToken: vi.fn(() => {
      return Promise.resolve({ token: 'redacted', source: 'store' })
    }),
  }
})

// Partial for the same reason. These are readers — a TCP probe and a TLS handshake against :443.
vi.mock('src/dev/proxy/portless-driver', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('src/dev/proxy/portless-driver')>()),
    listRoutes: () => {
      return []
    },
    resolvePortlessBin: () => {
      return '/nowhere/portless'
    },
    readCaPath: () => {
      return '/nowhere/ca.pem'
    },
    caFingerprintMatches: () => {
      return true
    },
    defaultIsListening: () => {
      return Promise.resolve(true)
    },
    defaultIsProxyServing: () => {
      return Promise.resolve(true)
    },
    handshakeChainsToCa: () => {
      return Promise.resolve({ ok: true })
    },
  }
})

/**
 * The `--version` rows keep their own spawn — `detail` is attached BESIDE them, never instead of them.
 * Rejecting `doppler` here is what lets the aws row and the doppler row be told apart from their
 * details.
 */
vi.mock('zx', async () => {
  // Imported INSIDE the factory: `vi.mock` is hoisted above the imports, and `doctor.ts` pulls
  // in `zx` at module scope, so a top-level binding is still in its TDZ when this runs.
  const { zxShellMock } = await import('src/lib/quiet-shell/__tests__/zx-shell-mock')

  return zxShellMock((_strings: TemplateStringsArray, command: string[]) => {
    if (command[0] === 'doppler' || command[0] === 'aws') return Promise.reject(new Error('exit 127'))

    return Promise.resolve({ stdout: '', stderr: '' })
  })
})

const rows = async () => {
  return (await doctor({ probeDeps: mixedInstall() })).structuredContent.checks
}

const rowNamed = async (name: string) => {
  const found = (await rows()).find((check) => {
    return check.name === name
  })

  if (!found) throw new Error(`doctor() emitted no check named "${name}"`)

  return found
}

describe('dependency rows carry the probe payload as `detail`', () => {
  it('reports a brew-owned install with its version', async () => {
    expect((await rowNamed('gh installed')).detail).toEqual({
      manager: 'homebrew',
      version: '2.62.0',
      present: true,
      onPath: true,
    })
  })

  it('reports an absent tool as present:false with no version', async () => {
    expect((await rowNamed('doppler installed')).detail).toEqual({
      manager: 'unknown',
      version: null,
      present: false,
      onPath: false,
    })
  })

  /**
   * The case that funds the whole design. The row means "resolves on PATH" and correctly FAILS; the
   * detail says the tool is installed anyway. A sibling `dependencies[]` array would have published
   * the same disagreement with no row to anchor it to.
   */
  it('reports the script-installed aws as failing ON PATH but present', async () => {
    const row = await rowNamed('aws installed')

    expect(row.status).toBe('fail')
    expect(row.detail).toEqual({ manager: 'script', version: '2.19.5', present: true, onPath: false })
  })

  it('adds a `brew installed` row of its own', async () => {
    const row = await rowNamed('brew installed')

    expect(row.status).toBe('pass')
    expect(row.detail?.present).toBe(true)
  })

  /**
   * `portless` resolves out of `node_modules`, never off PATH, so a probe payload would answer a
   * different question than the row asks. The exclusion is argued in `probe-argv-single-source.test.ts`
   * and pinned here on the output as well as on the source.
   */
  it('leaves `portless installed` without a detail', async () => {
    expect((await rowNamed('portless installed')).detail).toBeUndefined()
  })

  /**
   * The runtime half of the "no action, no commands" seam. The type-level half is in
   * `probe-argv-single-source.test.ts`; this one catches a payload widened at run time — a spread of
   * the install report into the row, which no type annotation on the interface would see.
   */
  it('publishes probe facts only — four keys, no action and no commands', async () => {
    const detail = (await rowNamed('gh installed')).detail

    expect(Object.keys(detail ?? {}).sort()).toEqual(['manager', 'onPath', 'present', 'version'])
  })
})

/**
 * I-2 — the two-command setup surface as an agent sees it: `setup` does, `doctor` diagnoses, and only
 * `setup` interrupts a human. The dependency question is therefore answerable WITHOUT a gate, which is
 * the property the whole surface rests on: a read path that prompts is a read path users learn to
 * click through.
 */
describe('the setup surface an agent sees', () => {
  // Every catalog row with a tool definition — `mcpExposed` is historical and an agent reaches every
  // command over Bash, so the subset the retired server registered is not the surface any more.
  const exposed = () => {
    return commandCatalog
      .flatMap((entry) => {
        return entry.mcpTool ? [entry.mcpTool] : []
      })
      .filter((tool) => {
        return tool.name === 'setup' || tool.name === 'doctor'
      })
      .sort((a, b) => {
        return a.name.localeCompare(b.name)
      })
  }

  it('exposes exactly two setup-surface tools, and gates only the one that installs', () => {
    expect(
      exposed().map((tool) => {
        return tool.name
      }),
    ).toEqual(['doctor', 'setup'])

    const ungated = exposed().filter((tool) => {
      return tool.requiresHumanConfirm !== true
    })

    expect(
      ungated.map((tool) => {
        return tool.name
      }),
    ).toEqual(['doctor'])
  })

  /**
   * Stated over every registry id rather than over the four detailed ones, so removing a row is a
   * failure rather than a narrowing. `portless` answers through its row's `status` because it carries
   * no `detail` — the deliberate exclusion above — and a boolean is a boolean either way.
   */
  it('answers `is it installed` for all five dependency ids, each as a boolean', async () => {
    const checks = await rows()
    const presence = new Map<DependencyId, boolean>()

    for (const id of DEPENDENCY_IDS) {
      const row = checks.find((check) => {
        return check.name === `${id} installed`
      })

      expect(row, `doctor() emitted no row for ${id}`).toBeDefined()
      presence.set(id, row?.detail?.present ?? row?.status === 'pass')
    }

    expect([...presence.keys()].sort()).toEqual([...DEPENDENCY_IDS].sort())

    for (const [id, present] of presence) {
      expect(present, `${id}'s presence is not a boolean`).toBeTypeOf('boolean')
    }
  })
})
