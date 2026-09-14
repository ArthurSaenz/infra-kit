import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { packageManagerInstallEnv } from 'src/lib/pm-env'

import packageJson from '../../../../package.json' with { type: 'json' }
import { buildOptions } from '../../../../scripts/build.js'

/**
 * Proves the load-bearing claim in the portless-link header: the updater's own verification spawn —
 * `<node> dist/cli.js version --json`, `cwd = $HOME`, package-manager env scrubbed — is what re-points
 * `~/.infra-kit/portless` after an install, and a project-local checkout never touches it.
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
  // Parsed from the WHOLE stdout: a stray line from the boot hook would fail here.
  expect(JSON.parse(run.stdout)).toEqual({ version: packageJson.version })
}

const readLink = (home: string): string => {
  const link = path.join(home, '.infra-kit', 'portless')

  expect(fs.lstatSync(link).isSymbolicLink(), `${link} must be a symlink`).toBe(true)

  return fs.readlinkSync(link)
}

beforeAll(async () => {
  // realpath'd up front: macOS hands out `/var/folders/…` for `/private/var/folders/…`, and the
  // install-manager compares the realpath of `self` against `$PNPM_HOME`.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-portless-link-')))
  buildDir = path.join(root, 'build')

  await esbuild.build({ ...buildOptions, outdir: buildDir })
}, 120_000)

afterAll(() => {
  fs.rmSync(root, { force: true, recursive: true })
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
})
