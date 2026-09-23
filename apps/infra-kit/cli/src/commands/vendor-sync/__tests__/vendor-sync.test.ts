import confirm from '@inquirer/confirm'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentMode } from 'src/lib/agent-mode'
import { commandEcho } from 'src/lib/command-echo'
import { CommandDeclinedError } from 'src/lib/errors/command-declined-error'
import { StructuredRefusalError } from 'src/lib/errors/structured-refusal-error'
import { getProjectRoot } from 'src/lib/git-utils'
import { getInfraKitConfig } from 'src/lib/infra-kit-config'
import type { InfraKitConfig } from 'src/lib/infra-kit-config'
import { jsonOutput } from 'src/lib/json-output'
import { loadFactoryConfig } from 'src/lib/vendor/factory-config'
import { applyTargetPlan, buildTargetPlan, probeSource, probeTarget, writeVendorMetaOnly } from 'src/lib/vendor/sync'
import type { SourceFacts, TargetPlan } from 'src/lib/vendor/sync'

import { preflightSource } from '../source-preflight'
import { vendorSync } from '../vendor-sync'

vi.mock('src/lib/git-utils', () => {
  return { getProjectRoot: vi.fn() }
})

vi.mock('../source-preflight', () => {
  return { preflightSource: vi.fn() }
})

vi.mock('src/lib/infra-kit-config', () => {
  return { getInfraKitConfig: vi.fn() }
})

vi.mock('src/lib/vendor/factory-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/vendor/factory-config')>()

  return { ...actual, loadFactoryConfig: vi.fn() }
})

vi.mock('src/lib/vendor/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/vendor/sync')>()

  return {
    ...actual,
    probeSource: vi.fn(),
    probeTarget: vi.fn(),
    buildTargetPlan: vi.fn(),
    applyTargetPlan: vi.fn(),
    writeVendorMetaOnly: vi.fn(),
    commitSyncedPaths: vi.fn(),
  }
})

vi.mock('src/lib/render/run-report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/lib/render/run-report')>()

  return { ...actual, printRunReport: vi.fn() }
})

vi.mock('src/lib/logger', () => {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

vi.mock('@inquirer/confirm')

const SOURCE: SourceFacts = {
  root: '/work/starter',
  selfRoots: ['/work/starter'],
  name: 'starter',
  headSha: 'abcdef1234567890',
  entries: [],
  exclude: [],
  legacyCleanup: [],
}

const plan = (name: string, status: TargetPlan['status']): TargetPlan => {
  return {
    name,
    root: `/work/${name}`,
    status,
    message: status === 'changed' ? '1 added, 0 modified, 0 removed on main' : 'up to date',
    notes: [],
    warnings: [],
    branch: 'main',
    entries: [],
    legacy: [],
    writeVendorMeta: false,
    recoveryPaths: [],
  }
}

const originalIsTTY = process.stdin.isTTY

const setStdinTTY = (value: boolean): void => {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

const run = (options: Parameters<typeof vendorSync>[0]): Promise<unknown> => {
  return vendorSync(options).catch((error: unknown) => {
    return error
  })
}

const touchedNothing = (): void => {
  expect(applyTargetPlan).not.toHaveBeenCalled()
  expect(writeVendorMetaOnly).not.toHaveBeenCalled()
}

const planned = (statuses: Record<string, TargetPlan['status']>): void => {
  vi.mocked(loadFactoryConfig).mockResolvedValue({ workspaceDir: '/work', targets: Object.keys(statuses) })
  vi.mocked(buildTargetPlan).mockImplementation((_source, facts) => {
    return plan(facts.name, statuses[facts.name]!)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  commandEcho.reset()
  setStdinTTY(false)
  vi.mocked(getProjectRoot).mockResolvedValue('/work/starter')
  vi.mocked(preflightSource).mockResolvedValue([{ name: 'working tree', status: 'ok', message: 'clean' }])
  vi.mocked(getInfraKitConfig).mockResolvedValue({
    vendorSource: { copy: [{ path: 'vendor/configs' }] },
  } as InfraKitConfig)
  vi.mocked(probeSource).mockResolvedValue(SOURCE)
  vi.mocked(probeTarget).mockImplementation(async (_source, ref) => {
    return { ...ref, kind: 'missing' }
  })
  vi.mocked(applyTargetPlan).mockResolvedValue({ touched: ['vendor/a'], manifestWritten: true })
  planned({ hulyo: 'changed', travelist: 'ok' })
})

afterEach(() => {
  agentMode.source = null
  jsonOutput.enabled = false
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
})

describe('vendorSync — human-only under agent mode', () => {
  it.each([
    ['--agent', false],
    ['--agent --yes', true],
  ])('%s refuses with status refused, exit 2, before any git or config read', async (_label, yes) => {
    agentMode.source = 'flag'

    const error = await run({ confirmedCommand: yes })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toEqual({ status: 'refused', agentMode: 'flag' })
    expect((error as StructuredRefusalError).exitCode).toBe(2)
    expect((error as StructuredRefusalError).stderrExcerpt).toContain('human-only')
    expect(getProjectRoot).not.toHaveBeenCalled()
    expect(preflightSource).not.toHaveBeenCalled()
    expect(getInfraKitConfig).not.toHaveBeenCalled()
    expect(loadFactoryConfig).not.toHaveBeenCalled()
    touchedNothing()
  })
})

describe('vendorSync — TTY gate for the apply', () => {
  it('refuses --yes on non-TTY stdin with exit 2 and writes nothing, even with INFRA_KIT_AGENT=0', async () => {
    vi.stubEnv('INFRA_KIT_AGENT', '0')

    const error = await run({ confirmedCommand: true })

    vi.unstubAllEnvs()

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({ status: 'refused', reason: 'no-tty' })
    expect((error as StructuredRefusalError).exitCode).toBe(2)
    expect((error as StructuredRefusalError).remediation).toContain('from a real terminal')
    touchedNothing()
  })

  it('previews on non-TTY stdin without --yes: no prompt, no write, exit 0', async () => {
    const result = (await vendorSync({})) as Awaited<ReturnType<typeof vendorSync>>

    expect(result.structuredContent).toMatchObject({ mode: 'preview', changed: true, failed: false })
    expect(confirm).not.toHaveBeenCalled()
    touchedNothing()
  })

  it('applies --yes on a TTY and reports the target as written', async () => {
    setStdinTTY(true)

    const result = await vendorSync({ confirmedCommand: true })

    expect(applyTargetPlan).toHaveBeenCalledTimes(1)
    expect(result.structuredContent).toMatchObject({ mode: 'applied', failed: false })
    expect(result.structuredContent.targets[0]).toMatchObject({ name: 'hulyo', applied: true })
  })
})

describe('vendorSync — decline', () => {
  it('throws CommandDeclinedError instead of exiting, so cleanup runs', async () => {
    setStdinTTY(true)
    vi.mocked(confirm).mockResolvedValue(false as never)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)

    const error = await run({})

    expect(error).toBeInstanceOf(CommandDeclinedError)
    expect(exit).not.toHaveBeenCalled()
    touchedNothing()
    exit.mockRestore()
  })
})

describe('vendorSync — gates', () => {
  it.each([undefined, null])('refuses naming vendorSource when it is %s', async (vendorSource) => {
    vi.mocked(getInfraKitConfig).mockResolvedValue({ vendorSource } as InfraKitConfig)

    const error = await run({})

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).exitCode).toBe(1)
    expect((error as StructuredRefusalError).stderrExcerpt).toContain('vendorSource')
    expect(getInfraKitConfig).toHaveBeenCalledWith({ autoMigrate: 'off' })
    expect(loadFactoryConfig).not.toHaveBeenCalled()
  })

  it('refuses unknown target names and lists the valid ones', async () => {
    const error = await run({ targets: ['hulyo', 'nope'] })

    expect(error).toBeInstanceOf(StructuredRefusalError)
    expect((error as StructuredRefusalError).structuredContent).toMatchObject({
      status: 'refused',
      unknown: ['nope'],
      valid: ['hulyo', 'travelist'],
    })
    expect((error as StructuredRefusalError).remediation).toContain('hulyo, travelist')
    expect(probeSource).not.toHaveBeenCalled()
  })

  it('narrows to the named targets', async () => {
    await vendorSync({ targets: ['travelist'] })

    expect(probeTarget).toHaveBeenCalledTimes(1)
    expect(vi.mocked(probeTarget).mock.calls[0]![1]).toEqual({ name: 'travelist', root: '/work/travelist' })
  })
})

describe('vendorSync --check', () => {
  it('reports changed (the action exits 1) and never prompts or writes', async () => {
    setStdinTTY(true)

    const result = await vendorSync({ check: true })

    expect(result.structuredContent).toMatchObject({ mode: 'check', changed: true, failed: false })
    expect(confirm).not.toHaveBeenCalled()
    touchedNothing()
  })

  it('reports clean when every target is ok or skipped', async () => {
    planned({ hulyo: 'ok', travelist: 'skipped' })

    const result = await vendorSync({ check: true })

    expect(result.structuredContent).toMatchObject({ mode: 'check', changed: false, failed: false })
  })

  it('a blocked target is a fail row', async () => {
    planned({ hulyo: 'fail', travelist: 'ok' })

    const result = await vendorSync({ check: true })

    expect(result.structuredContent.failed).toBe(true)
  })
})

describe('vendorSync — apply failures', () => {
  it('marks a failing target fail with the recovery argv and still applies the next one', async () => {
    setStdinTTY(true)
    planned({ hulyo: 'changed', travelist: 'changed' })
    vi.mocked(applyTargetPlan)
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValueOnce({ touched: ['vendor/a'], manifestWritten: true })

    const result = await vendorSync({ confirmedCommand: true })
    const hulyo = result.structuredContent.report.find((section) => {
      return section.label === 'hulyo'
    })!

    expect(applyTargetPlan).toHaveBeenCalledTimes(2)
    expect(result.structuredContent.failed).toBe(true)
    expect(hulyo.rows[0]).toMatchObject({ status: 'fail' })
    expect(hulyo.rows[0]!.notes!.join('\n')).toContain('checkout HEAD')
    expect(result.structuredContent.targets[1]).toMatchObject({ name: 'travelist', applied: true })
  })
})
