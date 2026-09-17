import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { portlessNodePath, portlessNodeSidecar } from 'src/dev/proxy/portless-node'
import type { PortlessNodeSidecar } from 'src/dev/proxy/portless-node'
import { packageManagerInstallEnv } from 'src/lib/pm-env'

import packageJson from '../../../../package.json' with { type: 'json' }
import { buildOptions } from '../../../../scripts/build.js'

/**
 * Proves the load-bearing claim in the portless-link header: the updater's own verification spawn —
 * `<node> dist/cli.js version --json`, `cwd = $HOME`, package-manager env scrubbed — is what re-points
 * `~/.infra-kit/portless` after an install, and a project-local checkout never touches it. The same
 * spawn converges `~/.infra-kit/node` (the stable-node plan), so its steps 1–5 ride the same layout.
 *
 * The bundle is built HERE with the real `buildOptions` (dist/ is gitignored and `qa` has no build
 * step, so a dist-reading test asserts nothing) and staged into a temp copy of pnpm 12's isolated
 * global layout: `PNPM_HOME/global/v11/{pid}-{ts}/node_modules/.pnpm/infra-kit@<v>/node_modules/`
 * holding `infra-kit/` beside a copy of the real `portless/`. `resolvePortlessBin` walks up from
 * `dist/` looking for `<dir>/node_modules/portless/package.json`, so that placement resolves exactly
 * as it does on a real pnpm-global machine. Every other runtime dependency is symlinked into the same
 * `node_modules` so the externalized bundle can load.
 */
const CLI_ROOT = path.resolve(import.meta.dirname, '../../../..')
const STORE_SEGMENT = `infra-kit@${packageJson.version}`

let root = ''
let buildDir = ''

const stagedCliPath = (globalDir: string): string => {
  return path.join(globalDir, 'node_modules/.pnpm', STORE_SEGMENT, 'node_modules/infra-kit/dist/cli.js')
}

const stagedPortlessDir = (globalDir: string): string => {
  return path.join(globalDir, 'node_modules/.pnpm', STORE_SEGMENT, 'node_modules/portless')
}

/**
 * Lay the built package and its runtime dependencies out under `siblingsDir/` — the `node_modules`
 * that holds `infra-kit/` and `portless/` side by side. portless is COPIED (its `dist/` and
 * `package.json`; the link must point at a directory that can be moved between runs), every other
 * dependency is a symlink to the real install, which Node realpaths so transitive deps resolve from
 * the store.
 */
const stagePackage = (siblingsDir: string): void => {
  const pkgDir = path.join(siblingsDir, 'infra-kit')

  fs.mkdirSync(pkgDir, { recursive: true })
  fs.cpSync(buildDir, path.join(pkgDir, 'dist'), { recursive: true })
  fs.copyFileSync(path.join(CLI_ROOT, 'package.json'), path.join(pkgDir, 'package.json'))

  for (const dep of Object.keys(packageJson.dependencies)) {
    const real = fs.realpathSync(path.join(CLI_ROOT, 'node_modules', dep))
    const dest = path.join(siblingsDir, dep)

    fs.mkdirSync(path.dirname(dest), { recursive: true })

    if (dep === 'portless') {
      fs.cpSync(real, dest, {
        recursive: true,
        filter: (source) => {
          return path.basename(source) !== 'node_modules'
        },
      })
    } else {
      fs.symlinkSync(real, dest)
    }
  }
}

interface VersionRun {
  status: number | null
  stdout: string
  stderr: string
}

/** EXACTLY the updater's invocation (`run-update-check.ts` `readInstalledVersion`), with `$HOME` and `$PNPM_HOME` redirected. */
const runVersionJson = (cliPath: string, input: { cwd: string; home: string; pnpmHome: string }): VersionRun => {
  const env = packageManagerInstallEnv(process.env)

  // The test runner's own tripwires and session markers must not leak into the child: a temp `$HOME`
  // is the isolation, the same one the real updater relies on.
  for (const key of Object.keys(env)) {
    if (key.startsWith('INFRA_KIT_')) delete env[key]
  }

  const result = spawnSync(process.execPath, [cliPath, 'version', '--json'], {
    cwd: input.cwd,
    env: { ...env, HOME: input.home, PNPM_HOME: input.pnpmHome, INFRA_KIT_NO_AUTO_UPDATE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  })

  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const expectVersionPayload = (run: VersionRun): void => {
  expect(run.status, run.stderr).toBe(0)
  // Parsed from the WHOLE stdout: a stray line from the boot hook would fail here. `toMatchObject`
  // because `version` also reports where it runs (cwd, repo roots, launch) — fields this test is not about.
  expect(JSON.parse(run.stdout)).toMatchObject({ version: packageJson.version })
}

const readLink = (home: string): string => {
  const link = path.join(home, '.infra-kit', 'portless')

  expect(fs.lstatSync(link).isSymbolicLink(), `${link} must be a symlink`).toBe(true)

  return fs.readlinkSync(link)
}

interface NodeSnapshot {
  ino: number
  dev: number
  size: number
  sidecar: PortlessNodeSidecar
}

/** The node file as the sidecar and the inode describe it — the two things a refresh changes and a converged run must not. */
const readNode = (home: string): NodeSnapshot => {
  const node = portlessNodePath(home)
  const stat = fs.lstatSync(node)

  expect(stat.isFile(), `${node} must be a regular file`).toBe(true)
  expect(stat.isSymbolicLink()).toBe(false)

  return {
    ino: stat.ino,
    dev: stat.dev,
    size: stat.size,
    sidecar: JSON.parse(fs.readFileSync(portlessNodeSidecar(home), 'utf8')) as PortlessNodeSidecar,
  }
}

/**
 * The developer's REAL `~/.infra-kit` as the suite found it, so every run below can prove it was never
 * touched: the temp `$HOME` is the isolation, and this is the assertion that the isolation held.
 */
interface RealHomeSnapshot {
  node: string | null
  sidecar: string | null
  link: string | null
}

const describeEntry = (target: string): string | null => {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false })

  return stat === undefined ? null : `${stat.ino}:${stat.dev}:${stat.size}:${stat.ctimeMs}:${stat.mtimeMs}`
}

const snapshotRealHome = (): RealHomeSnapshot => {
  const home = os.homedir()

  return {
    node: describeEntry(portlessNodePath(home)),
    sidecar: describeEntry(portlessNodeSidecar(home)),
    link: describeEntry(path.join(home, '.infra-kit', 'portless')),
  }
}

let realHomeBefore: RealHomeSnapshot

beforeAll(async () => {
  // realpath'd up front: macOS hands out `/var/folders/…` for `/private/var/folders/…`, and the
  // install-manager compares the realpath of `self` against `$PNPM_HOME`.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-portless-link-')))
  buildDir = path.join(root, 'build')
  realHomeBefore = snapshotRealHome()

  await esbuild.build({ ...buildOptions, outdir: buildDir })
}, 120_000)

afterAll(() => {
  fs.rmSync(root, { force: true, recursive: true })
  expect(snapshotRealHome(), 'the real ~/.infra-kit must be exactly as the suite found it').toEqual(realHomeBefore)
})

describe('portless link across the updater invocation', () => {
  it('pnpm-global install: `version --json` from $HOME creates the link, a moved install re-points it, a checkout leaves it alone', () => {
    const home = path.join(root, 'home')
    const pnpmHome = path.join(root, 'pnpm-home')
    const firstGlobal = path.join(pnpmHome, 'global/v11/1234-1')

    fs.mkdirSync(home, { recursive: true })
    stagePackage(path.join(firstGlobal, 'node_modules/.pnpm', STORE_SEGMENT, 'node_modules'))

    // Run 1 — fresh machine: no ~/.infra-kit at all.
    const first = runVersionJson(stagedCliPath(firstGlobal), { cwd: home, home, pnpmHome })

    expectVersionPayload(first)
    expect(first.stderr, 'the boot hook must not write to stderr on the updater path').toBe('')
    expect(readLink(home)).toBe(stagedPortlessDir(firstGlobal))

    // Run 2 — the next `pnpm add -g` minted a new `{pid}-{ts}` project dir and removed the old one.
    const secondGlobal = path.join(pnpmHome, 'global/v11/5678-2')

    fs.renameSync(firstGlobal, secondGlobal)

    const second = runVersionJson(stagedCliPath(secondGlobal), { cwd: home, home, pnpmHome })

    expectVersionPayload(second)
    expect(readLink(home)).toBe(stagedPortlessDir(secondGlobal))
    expect(fs.existsSync(path.join(readLink(home), 'dist/cli.js')), 'the link must resolve to a live portless').toBe(
      true,
    )

    // Run 3 — a checkout with the same build under its node_modules. Placed UNDER $PNPM_HOME on
    // purpose: that is the "repo cloned under $PNPM_HOME" shape where the manager matcher says
    // "pnpm", so only the `.git` walk stands between this run and re-pointing the root daemon at a
    // worktree.
    const project = path.join(root, 'proj')

    fs.mkdirSync(path.join(project, '.git'), { recursive: true })
    stagePackage(path.join(project, 'node_modules'))

    const third = runVersionJson(path.join(project, 'node_modules/infra-kit/dist/cli.js'), {
      cwd: project,
      home,
      pnpmHome: root,
    })

    expectVersionPayload(third)
    expect(readLink(home)).toBe(stagedPortlessDir(secondGlobal))
  }, 120_000)

  it('pnpm-global install: `version --json` from $HOME hardlinks ~/.infra-kit/node, which runs; a converged run rewrites nothing; a foreign inode is relinked; a checkout never creates it', () => {
    const home = path.join(root, 'node-home')
    const pnpmHome = path.join(root, 'node-pnpm-home')
    const globalDir = path.join(pnpmHome, 'global/v11/1234-1')
    const node = portlessNodePath(home)
    const exec = fs.statSync(process.execPath)

    fs.mkdirSync(home, { recursive: true })
    stagePackage(path.join(globalDir, 'node_modules/.pnpm', STORE_SEGMENT, 'node_modules'))

    // Step 1 — the first run creates the file. A hardlink where the temp dir shares a volume with the
    // build's node (this machine); a CI whose tmp is another volume degrades to the copy path, and the
    // assertion degrades with it: same size, `method: 'copy'`.
    const first = runVersionJson(stagedCliPath(globalDir), { cwd: home, home, pnpmHome })

    expectVersionPayload(first)
    expect(first.stderr, 'the boot hook must not write to stderr on the updater path').toBe('')

    const created = readNode(home)
    const hardlinked = created.ino === exec.ino && created.dev === exec.dev

    expect(created.sidecar).toMatchObject({ version: process.version, arch: process.arch, platform: process.platform })
    expect(created.sidecar.method).toBe(hardlinked ? 'hardlink' : 'copy')
    expect(created.size).toBe(exec.size)

    // Step 2 — the file RUNS, and it is what Node reports as itself: a regular file is never realpath'd
    // away, so `service install` run through it would bake exactly this path into the plist.
    const self = spawnSync(node, ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 10_000 })

    expect(self.status, self.stderr).toBe(0)
    expect(self.stdout.trim()).toBe(node)
    expect(spawnSync(node, ['-v'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim()).toBe(process.version)

    // Step 3 — a converged machine: no rewrite. Inode AND `refreshedAt` — not mtime, which a hardlink
    // shares with its source and says nothing about this file.
    expectVersionPayload(runVersionJson(stagedCliPath(globalDir), { cwd: home, home, pnpmHome }))
    expect(readNode(home)).toEqual(created)

    // Step 4 — a foreign inode under the published name (the re-mint scenario, simulated: same bytes,
    // different inode). T-1: staged under a NEW name and RENAMED over the hardlink. NEVER copyFileSync
    // straight onto the node path — after step 1 that name IS the running vitest node's inode (shared
    // with the developer's real node), copyFileSync opens its destination O_TRUNC, and macOS has no
    // ETXTBSY, so it would truncate the binary this process is running from.
    if (hardlinked) {
      const foreign = path.join(home, '.infra-kit', 'node.foreign')

      fs.copyFileSync(process.execPath, foreign)
      fs.renameSync(foreign, node)
      expect(fs.lstatSync(node).ino).not.toBe(exec.ino)

      expectVersionPayload(runVersionJson(stagedCliPath(globalDir), { cwd: home, home, pnpmHome }))

      const relinked = readNode(home)

      expect([relinked.ino, relinked.dev]).toEqual([exec.ino, exec.dev])
      expect(relinked.sidecar.refreshedAt > created.sidecar.refreshedAt, 'refreshedAt must advance on a relink').toBe(
        true,
      )
      expect(relinked.sidecar.versionChangedAt, 'a same-version relink carries the Node clock over').toBe(
        created.sidecar.versionChangedAt,
      )
    }

    // Step 5 — a checkout-shaped invocation never creates the file: a fresh $HOME stays empty of it,
    // and the converged one is not touched either.
    const checkoutHome = path.join(root, 'checkout-home')
    const project = path.join(root, 'node-proj')

    fs.mkdirSync(checkoutHome, { recursive: true })
    fs.mkdirSync(path.join(project, '.git'), { recursive: true })
    stagePackage(path.join(project, 'node_modules'))

    const cliPath = path.join(project, 'node_modules/infra-kit/dist/cli.js')
    const before = readNode(home)

    expectVersionPayload(runVersionJson(cliPath, { cwd: project, home: checkoutHome, pnpmHome: root }))
    expect(fs.existsSync(portlessNodePath(checkoutHome))).toBe(false)
    expect(fs.existsSync(portlessNodeSidecar(checkoutHome))).toBe(false)

    expectVersionPayload(runVersionJson(cliPath, { cwd: project, home, pnpmHome: root }))
    expect(readNode(home)).toEqual(before)
  }, 120_000)
})
