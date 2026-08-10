import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_STOP_BYTES,
  installModuleGeneration,
  isModuleGenerationSupported,
  resetModuleGenerationForTests,
  resolveStopBudget,
  selfDistDir,
} from 'src/dev/module-generation'
import type { InstallOptions, ModuleGenerationHandle } from 'src/dev/module-generation'

import { createTempTracker } from './fixtures'

const temp = createTempTracker()

afterEach(() => {
  temp.cleanup()
  resetModuleGenerationForTests()
})

const SRC = path.resolve(__dirname, '..', 'module-generation.ts')

/**
 * Bundle `module-generation.ts` to a standalone ESM file a real `node` can import.
 *
 * Why a subprocess at all: under vitest every `import()` inside a transformed module is rewritten to
 * vite-node's own loader, so Node's ESM resolver — the only thing `module.registerHooks` can hook — is
 * never consulted. An in-process assertion here would report zero busts no matter how correct the hook
 * is, i.e. it would be a test that cannot pass, sitting next to one that cannot fail. Production runs a
 * plain esbuild bundle under plain node, and so does this.
 */
const bundleHook = (dir: string): string => {
  const outfile = path.join(dir, 'module-generation.mjs')

  esbuild.buildSync({ bundle: true, entryPoints: [SRC], format: 'esm', outfile, platform: 'node' })

  return outfile
}

/**
 * A pnpm-shaped fixture: an app entry importing a workspace package by BARE specifier through a
 * `node_modules` symlink, exactly as `apps/x/api` imports `@pkg/lib`. The symlink is load-bearing — it
 * is what makes the realpath ordering of the `node_modules` rule observable rather than theoretical.
 */
const makeGraph = (): { appEntry: string; root: string; sharedDir: string; sharedIndex: string } => {
  const root = fs.realpathSync(temp.register(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-modgen-'))))
  const sharedDir = path.join(root, 'packages', 'shared')
  const app = path.join(root, 'apps', 'appx', 'api')

  fs.mkdirSync(sharedDir, { recursive: true })
  fs.mkdirSync(path.join(app, 'node_modules', '@pkg'), { recursive: true })
  fs.writeFileSync(
    path.join(sharedDir, 'package.json'),
    JSON.stringify({ name: '@pkg/shared', type: 'module', main: 'index.js' }),
  )
  fs.writeFileSync(path.join(sharedDir, 'index.js'), 'export const v = 1\n')
  fs.symlinkSync(sharedDir, path.join(app, 'node_modules', '@pkg', 'shared'), 'dir')
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'appx-api', type: 'module' }))

  const appEntry = path.join(app, 'entry.js')

  fs.writeFileSync(appEntry, "export { v } from '@pkg/shared'\n")

  return { appEntry, root, sharedDir, sharedIndex: path.join(sharedDir, 'index.js') }
}

/** Run `script` in a real node process and parse the single JSON line it prints. */
const runInNode = (dir: string, script: string): Record<string, unknown> => {
  const file = path.join(dir, 'probe.mjs')

  fs.writeFileSync(file, script)

  return JSON.parse(execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim()) as Record<string, unknown>
}

describe('module generation hook — real node ESM resolution', () => {
  it('re-evaluates a workspace package imported through a node_modules symlink, without a new process', () => {
    /**
     * The core claim, and the whole reason this module exists. WITHOUT the hook, re-importing the entry
     * under a fresh query re-evaluates the ENTRY and nothing else — Node's registry is keyed by resolved
     * URL, so the shared package stays at v=1 for the life of the process. That is the reported bug.
     * `baseline` reproduces it in the same run, so this test states a DIFFERENCE rather than asserting a
     * number that might have been right by accident.
     */
    const dir = temp.register(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-modgen-run-')))
    const hookFile = bundleHook(dir)
    const { appEntry, root, sharedDir, sharedIndex } = makeGraph()

    const out = runInNode(
      dir,
      `
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { installModuleGeneration, selfDistDir } from ${JSON.stringify(pathToFileUrlString(hookFile))}

const load = async (tag) => {
  const u = pathToFileURL(${JSON.stringify(appEntry)})
  u.searchParams.set('v', tag)
  return (await import(u.href)).v
}

// Baseline: the CURRENT behaviour, with no hook installed at all.
const baselineFirst = await load('a')
fs.writeFileSync(${JSON.stringify(sharedIndex)}, 'export const v = 2\\n')
const baselineSecond = await load('b')

// Now install the hook and repeat with a generation bump.
const handle = installModuleGeneration({ root: ${JSON.stringify(root)}, selfDist: selfDistDir() })
const hookedFirst = await load('c')
fs.writeFileSync(${JSON.stringify(sharedIndex)}, 'export const v = 3\\n')
handle.bump()
const hookedSecond = await load('d')

console.log(JSON.stringify({
  baselineFirst, baselineSecond, hookedFirst, hookedSecond,
  bustedShared: handle.bustedUnder(${JSON.stringify(sharedDir)}),
  onePid: true,
}))
`,
    )

    // The bug, reproduced: a fresh query on the entry does NOT pick up the rewritten shared package.
    expect(out.baselineFirst).toBe(1)
    expect(out.baselineSecond).toBe(1)

    // The fix: after a generation bump the shared package is re-evaluated — same process, no restart.
    expect(out.hookedSecond).toBe(3)
    expect(out.hookedSecond).not.toBe(out.hookedFirst)

    // And the hook can prove it re-resolved that package, which is what the runner's check reads.
    expect(out.bustedShared).toBe(true)
  }, 60000)

  it('never busts the CLI’s own bundle, whatever its chunks are named', () => {
    /**
     * The build emits content-hashed chunks (`boot-OA6HGGO6.js`), so the exclusion is by realpath'd
     * DIRECTORY — a name pattern would rot at the next build. Re-evaluating the CLI mid-session would
     * give the run two Inks and two Reacts. Here the hook's root is pointed AT the CLI dir, so every
     * containment rule passes and only the self-exclusion can hold it back.
     */
    const dir = temp.register(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-modgen-self-')))
    const hookFile = bundleHook(dir)
    const selfMod = path.join(dir, 'chunk-ABC123XY.js')

    fs.writeFileSync(selfMod, 'export const loaded = 1\n')

    const out = runInNode(
      dir,
      `
import { pathToFileURL } from 'node:url'
import { installModuleGeneration } from ${JSON.stringify(pathToFileUrlString(hookFile))}

// root === selfDist: the module is inside the watched root AND inside the CLI's own output.
const handle = installModuleGeneration({ root: ${JSON.stringify(dir)}, selfDist: ${JSON.stringify(dir)} })
handle.bump()
await import(pathToFileURL(${JSON.stringify(selfMod)}).href)

console.log(JSON.stringify({ bustedSelf: handle.bustedUnder(${JSON.stringify(dir)}) }))
`,
    )

    expect(out.bustedSelf).toBe(false)
  }, 60000)

  it('leaves third-party node_modules alone while busting workspace packages', () => {
    // Both live under the root; only the workspace one realpaths OUT of `node_modules`. This is the
    // rule that silently excludes every `@pkg/*` if it is ever evaluated before realpath.
    const dir = temp.register(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-modgen-nm-')))
    const hookFile = bundleHook(dir)
    const { appEntry, root, sharedDir } = makeGraph()
    const vendorDir = path.join(root, 'apps', 'appx', 'api', 'node_modules', 'left-pad')

    fs.mkdirSync(vendorDir, { recursive: true })
    fs.writeFileSync(
      path.join(vendorDir, 'package.json'),
      JSON.stringify({ name: 'left-pad', type: 'module', main: 'index.js' }),
    )
    fs.writeFileSync(path.join(vendorDir, 'index.js'), 'export const pad = 1\n')
    fs.writeFileSync(appEntry, "export { v } from '@pkg/shared'\nexport { pad } from 'left-pad'\n")

    const out = runInNode(
      dir,
      `
import { pathToFileURL } from 'node:url'
import { installModuleGeneration, selfDistDir } from ${JSON.stringify(pathToFileUrlString(hookFile))}

const handle = installModuleGeneration({ root: ${JSON.stringify(root)}, selfDist: selfDistDir() })
handle.bump()
await import(pathToFileURL(${JSON.stringify(appEntry)}).href)

console.log(JSON.stringify({
  bustedWorkspace: handle.bustedUnder(${JSON.stringify(sharedDir)}),
  bustedVendor: handle.bustedUnder(${JSON.stringify(vendorDir)}),
}))
`,
    )

    expect(out.bustedWorkspace).toBe(true)
    expect(out.bustedVendor).toBe(false)
  }, 60000)
})

describe('module generation hook — bookkeeping', () => {
  it('is available on this runtime', () => {
    // If this ever fails the approach is unavailable and the runner must say so, not degrade silently.
    expect(isModuleGenerationSupported()).toBe(true)
  })

  it('keeps counting generations without the count ever gating anything', () => {
    const { root } = makeGraph()
    const handle = installModuleGeneration({
      root,
      selfDist: selfDistDir(),
      // Far below `warnBytes` (= 400), so nothing the budget does can interfere with the count.
      sampleRss: () => {
        return 10
      },
      stopBytes: 800,
    })

    for (let i = 0; i < 500; i += 1) {
      expect(handle?.budgetState()).toBe('ok')
      handle?.bump()
    }

    expect(handle?.generation()).toBe(500)
  })
})

/**
 * The guard reads BYTES. A generation count cannot carry the meaning it was asked to: every generation
 * costs whatever the consumer's module graph costs, so a count calibrated on one repo is wrong for the
 * next. These specs drive `sampleRss` directly, which is the whole reason it is a seam.
 */
describe('module generation hook — the byte budget', () => {
  const budgetHandle = (opts: Partial<InstallOptions> & { samples: number[] }): ModuleGenerationHandle => {
    const { root } = makeGraph()
    let index = 0
    const handle = installModuleGeneration({
      root,
      selfDist: selfDistDir(),
      sampleRss: () => {
        const value = opts.samples[Math.min(index, opts.samples.length - 1)] ?? 0

        index += 1

        return value
      },
      stopBytes: opts.stopBytes,
      stopEnabled: opts.stopEnabled,
      warnStrideBytes: opts.warnStrideBytes,
    })

    if (handle == null) throw new Error('the hook is unavailable on this runtime')

    return handle
  }
  const verdicts = (handle: ModuleGenerationHandle, count: number): string[] => {
    return Array.from({ length: count }, () => {
      return handle.budgetState()
    })
  }

  it('derives the warn threshold from the budget rather than taking a second number', () => {
    // stopBytes 800 ⇒ warnBytes 400. 399 is below it, 400 is on it.
    expect(verdicts(budgetHandle({ samples: [399, 400], stopBytes: 800, warnStrideBytes: 100 }), 2)).toEqual([
      'ok',
      'warn',
    ])
  })

  it('re-warns on a GROWTH STRIDE, so a session that keeps growing keeps saying so', () => {
    // A latching implementation — one warning per session lifetime, the defect this replaced — returns
    // exactly one 'warn' here and fails.
    expect(
      verdicts(budgetHandle({ samples: [400, 420, 500, 520, 600], stopBytes: 800, warnStrideBytes: 100 }), 5),
    ).toEqual(['warn', 'ok', 'warn', 'ok', 'warn'])
  })

  it('stays quiet for a session that sits flat above the warn threshold', () => {
    expect(verdicts(budgetHandle({ samples: [400, 401, 402, 403], stopBytes: 800, warnStrideBytes: 100 }), 4)).toEqual([
      'warn',
      'ok',
      'ok',
      'ok',
    ])
  })

  it('requires TWO consecutive over-budget samples, so a GC-timing spike cannot end a session', () => {
    const one = budgetHandle({ samples: [801], stopBytes: 800, warnStrideBytes: 100 })

    expect(verdicts(one, 1)).not.toContain('stop')

    const two = budgetHandle({ samples: [801, 801], stopBytes: 800, warnStrideBytes: 100 })

    expect(verdicts(two, 2)[1]).toBe('stop')

    const broken = budgetHandle({ samples: [801, 799, 801], stopBytes: 800, warnStrideBytes: 100 })

    expect(verdicts(broken, 3)).not.toContain('stop')
  })

  it('never touches `busted` — the D3 regression that would print a green restart over stale code', () => {
    const { root } = makeGraph()
    const handle = installModuleGeneration({
      root,
      selfDist: selfDistDir(),
      sampleRss: () => {
        return 801
      },
      stopBytes: 800,
    })

    handle?.bump()
    const before = handle?.bustedUnder(root)

    expect(handle?.budgetState()).toBe('warn')
    expect(handle?.budgetState()).toBe('stop')
    expect(handle?.bustedUnder(root)).toBe(before)
  })

  it('`off` suppresses only the STOP, leaving both warn thresholds at their real values', () => {
    /**
     * The trap this pins: modelling "off" as `stopBytes = 0` would drag `warnBytes` to 0 and remove the
     * floor, so sample 399 would clear the explicit stride (399 >= 0 + 100) and warn. Here it must stay
     * `'ok'`. And 5000 twice consecutively — well over the 800 budget — must never reach `'stop'`.
     */
    expect(
      verdicts(
        budgetHandle({
          samples: [10, 399, 400, 420, 500, 900, 5000, 5000],
          stopBytes: 800,
          stopEnabled: false,
          warnStrideBytes: 100,
        }),
        8,
      ),
    ).toEqual(['ok', 'ok', 'warn', 'ok', 'warn', 'warn', 'warn', 'ok'])
  })
})

describe('resolveStopBudget — the env override', () => {
  it('reads a positive integer as the budget, with the stop armed', () => {
    expect(resolveStopBudget('1500000000')).toEqual({ stopEnabled: true, stopBytes: 1_500_000_000 })
  })

  it('treats `0` and `off` as "disable the stop", PRESERVING the budget the warns derive from', () => {
    expect(resolveStopBudget('0')).toEqual({ stopEnabled: false, stopBytes: DEFAULT_STOP_BYTES })
    expect(resolveStopBudget('off')).toEqual({ stopEnabled: false, stopBytes: DEFAULT_STOP_BYTES })
  })

  it('falls back to the default budget when unset or unparseable', () => {
    expect(resolveStopBudget(undefined)).toEqual({ stopEnabled: true, stopBytes: DEFAULT_STOP_BYTES })
    expect(resolveStopBudget('banana')).toEqual({ stopEnabled: true, stopBytes: DEFAULT_STOP_BYTES })
  })
})

/** `pathToFileURL(...).href`, needed as a literal inside generated probe scripts. */
function pathToFileUrlString(p: string): string {
  return `file://${p}`
}
