#!/usr/bin/env node
// Publishes the four infra-kit packages in the ONE order that does not wedge the monorepo.
//
// `infra-kit` and `@slip-stream-kit/vite` depend on `@slip-stream-kit/config` through a REGISTRY range
// (`^x.y.z`, not `workspace:*`), and pnpm 11 `verify-deps` runs on every `pnpm exec`. Re-pin that range
// before the new config exists on npm and every pnpm command in the repo dies with
// ERR_PNPM_NO_MATCHING_VERSION — turbo, lint, test, all of it. So the order is fixed:
//   1. publish config            (version fields are already bumped; the pins still say the OLD version)
//   2. re-pin cli + vite to ^new, `pnpm install --no-frozen-lockfile`, commit
//   3. publish cli, eslint-plugin, vite
//   4. `pnpm add -g infra-kit@new`, `claude plugin update` in every repo that installed the plugin
//
// Every step is a no-op when already done (registry has the version, pin already points at it), so a
// run interrupted by a failed OTP is simply re-run. npm needs an interactive OTP, which is why this is
// a script for a REAL terminal and not a CLI command: the Claude Code `!` shell is non-TTY and npm
// answers it with ERR_PNPM_OTP_NON_INTERACTIVE.
//
// Two npm answers that look like failures and are not: `409 Cannot publish over previously staged
// version` means the tarball WAS accepted and is being processed — the poll below waits it out. And
// `pnpm view` is served from a stale metadata cache, so "is it live?" is asked of the registry directly.
//
// Usage:  node scripts/publish-lockstep.mjs [--skip-plugin-update] [--allow-dirty]
// Exit:   non-zero on the first step that cannot be completed; re-run to resume.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const APPS = path.join(REPO_ROOT, 'apps', 'infra-kit')
const CONFIG_PKG = '@slip-stream-kit/config'
// Publish order. `config` first is the whole point (see the header); the other three only depend on
// it, never on each other, so their order is convention from the previous releases.
const PACKAGES = [
  { name: CONFIG_PKG, dir: path.join(APPS, 'config') },
  { name: 'infra-kit', dir: path.join(APPS, 'cli') },
  { name: '@slip-stream-kit/eslint-plugin', dir: path.join(APPS, 'eslint-plugin') },
  { name: '@slip-stream-kit/vite', dir: path.join(APPS, 'vite') },
]
// The packages whose `dependencies` carry the registry range on config (step 2).
const PINNED_DIRS = [path.join(APPS, 'cli'), path.join(APPS, 'vite')]
// Everything the release bump must have moved together; a mismatch means the bump commit is half done.
const VERSION_FIELDS = [
  ...PACKAGES.map((pkg) => {
    return { file: path.join(pkg.dir, 'package.json'), read: (text) => JSON.parse(text).version }
  }),
  {
    file: path.join(REPO_ROOT, 'plugins', 'infra-kit', '.claude-plugin', 'plugin.json'),
    read: (text) => JSON.parse(text).version,
  },
  {
    file: path.join(APPS, 'eslint-plugin', 'src', 'index.ts'),
    read: (text) => /version:\s*'([^']+)'/.exec(text)?.[1],
  },
]
const REGISTRY_POLL_MS = 10_000
const REGISTRY_POLL_MAX_MS = 6 * 60_000

const args = new Set(process.argv.slice(2))
const skipPluginUpdate = args.has('--skip-plugin-update')
const allowDirty = args.has('--allow-dirty')

const log = (line) => {
  return console.log(`\n▶ ${line}`)
}

const fail = (message) => {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

/** Runs a command with the terminal attached — npm's OTP prompt has to reach the user. */
const run = (cmd, cmdArgs, cwd) => {
  console.log(
    `  $ ${[cmd, ...cmdArgs].join(' ')}${cwd === REPO_ROOT ? '' : `   (in ${path.relative(REPO_ROOT, cwd)})`}`,
  )
  const result = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} exited ${result.status}`)
}

const capture = (cmd, cmdArgs, cwd = REPO_ROOT) => {
  return execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8' }).trim()
}

const readJson = (file) => {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** The registry's own record — `time[version]` exists the moment a publish has been processed. */
const isPublished = async (name, version) => {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`registry answered ${response.status} for ${name}`)
  const body = await response.json()
  return Boolean(body.time?.[version])
}

const waitUntilPublished = async (name, version) => {
  const deadline = Date.now() + REGISTRY_POLL_MAX_MS
  while (Date.now() < deadline) {
    if (await isPublished(name, version)) return
    process.stdout.write('.')
    await new Promise((resolve) => {
      return setTimeout(resolve, REGISTRY_POLL_MS)
    })
  }
  fail(
    `${name}@${version} did not appear on the registry within ${REGISTRY_POLL_MAX_MS / 60_000} min — re-run to keep waiting`,
  )
}

/**
 * Packs the tarball and reads the package.json npm would receive. `catalog:` and `workspace:` ranges
 * have leaked into published runtime deps before (`catalogMode: manual` does not prevent it), and a
 * consumer install then fails on a protocol npm does not know. `pnpm pack` runs `prepack` (the build),
 * so this doubles the build per package — cheap next to an unpublishable version that cannot be unpublished.
 */
const assertTarballClean = (pkg, version) => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-pack-'))
  try {
    run('pnpm', ['pack', '--pack-destination', dest], pkg.dir)
    const tarball = fs.readdirSync(dest).find((entry) => {
      return entry.endsWith('.tgz')
    })
    if (!tarball) throw new Error(`pnpm pack produced no tarball for ${pkg.name}`)
    const manifest = JSON.parse(capture('tar', ['-xOf', path.join(dest, tarball), 'package/package.json']))

    if (manifest.version !== version) {
      fail(`${pkg.name}: tarball says ${manifest.version}, tree says ${version}`)
    }
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (/^(catalog|workspace|link|file):/.test(range)) {
          fail(`${pkg.name}: ${field}.${dep} = "${range}" would ship in the tarball — fix the range before publishing`)
        }
      }
    }
  } finally {
    fs.rmSync(dest, { recursive: true, force: true })
  }
}

const publish = async (pkg, version) => {
  if (await isPublished(pkg.name, version)) {
    console.log(`  ${pkg.name}@${version} is already on the registry — skipping`)
    return
  }
  assertTarballClean(pkg, version)
  try {
    run('pnpm', ['publish', '--no-git-checks'], pkg.dir)
  } catch (error) {
    // The 409 "previously staged" answer means the upload landed and npm is still processing it; the
    // poll below distinguishes that from a real refusal by asking the registry.
    console.log(`  publish returned an error (${error.message}); checking the registry before giving up`)
  }
  process.stdout.write(`  waiting for ${pkg.name}@${version} on the registry`)
  await waitUntilPublished(pkg.name, version)
  console.log(' live')
}

const resolveVersion = () => {
  const seen = VERSION_FIELDS.map((field) => {
    return { file: path.relative(REPO_ROOT, field.file), version: field.read(fs.readFileSync(field.file, 'utf8')) }
  })
  const versions = new Set(
    seen.map((entry) => {
      return entry.version
    }),
  )
  if (versions.size !== 1) {
    fail(
      `the version fields disagree — finish the bump commit first:\n${seen
        .map((entry) => {
          return `    ${entry.version ?? '(missing)'}  ${entry.file}`
        })
        .join('\n')}`,
    )
  }
  return [...versions][0]
}

const assertPublishableTree = () => {
  const status = capture('git', ['status', '--porcelain'])
  if (!status) return
  const count = status.split('\n').length
  if (allowDirty) {
    console.log(`  ⚠ ${count} uncommitted path(s) will ship in the tarballs (--allow-dirty)`)
    return
  }
  fail(
    `${count} uncommitted path(s) — prepack builds from the working tree, so the published version would not match any commit.\n` +
      '  Commit first, or pass --allow-dirty if that is what you mean.',
  )
}

const repinConfig = (version) => {
  const range = `^${version}`
  const changed = PINNED_DIRS.filter((dir) => {
    const file = path.join(dir, 'package.json')
    const manifest = readJson(file)
    if (manifest.dependencies?.[CONFIG_PKG] === range) return false
    // Text replacement rather than JSON.stringify: the file's formatting is prettier's, not node's.
    const text = fs.readFileSync(file, 'utf8')
    const next = text.replace(new RegExp(`("${CONFIG_PKG}":\\s*)"[^"]+"`), `$1"${range}"`)
    if (next === text) fail(`could not find the ${CONFIG_PKG} pin in ${path.relative(REPO_ROOT, file)}`)
    fs.writeFileSync(file, next)
    return true
  })

  if (changed.length === 0) {
    console.log(`  cli + vite already pin ${CONFIG_PKG} at ${range} — skipping`)
    return
  }
  // `--no-frozen-lockfile`: the lockfile has to move to the version that now exists on the registry.
  run('pnpm', ['install', '--no-frozen-lockfile'], REPO_ROOT)
  run(
    'git',
    [
      'add',
      ...changed.map((dir) => {
        return path.join(dir, 'package.json')
      }),
      'pnpm-lock.yaml',
    ],
    REPO_ROOT,
  )
  run('git', ['commit', '-m', `[DO] release ${version}: pin ${CONFIG_PKG} at ${range}`], REPO_ROOT)
}

const installGlobal = (version) => {
  // Exact version, not `@latest`: pnpm serves the dist-tag from a metadata cache it never revalidates.
  run('pnpm', ['add', '-g', `infra-kit@${version}`], REPO_ROOT)
}

/** Every repo that installed the plugin at project scope; the list is derived, not maintained. */
const pluginConsumers = () => {
  const projects = path.join(os.homedir(), 'projects')
  if (!fs.existsSync(projects)) return []
  return fs
    .readdirSync(projects, { withFileTypes: true })
    .filter((entry) => {
      return entry.isDirectory()
    })
    .map((entry) => {
      return path.join(projects, entry.name)
    })
    .filter((dir) => {
      const settings = path.join(dir, '.claude', 'settings.json')
      return fs.existsSync(settings) && fs.readFileSync(settings, 'utf8').includes('"infra-kit@infra-kit"')
    })
}

const updatePlugins = () => {
  const failures = []
  for (const dir of pluginConsumers()) {
    try {
      run('claude', ['plugin', 'update', 'infra-kit@infra-kit', '--scope', 'project'], dir)
    } catch (error) {
      failures.push(`${path.basename(dir)}: ${error.message}`)
    }
  }
  // Reported, not raised: the npm side is done and irreversible by now; a plugin update is re-runnable by hand.
  if (failures.length > 0) console.log(`  ⚠ plugin update failed in:\n    ${failures.join('\n    ')}`)
}

const main = async () => {
  const version = resolveVersion()
  log(`release ${version}`)
  assertPublishableTree()

  log(`1/4 publish ${CONFIG_PKG}@${version}`)
  await publish(PACKAGES[0], version)

  log(`2/4 re-pin ${CONFIG_PKG} at ^${version} in cli + vite`)
  repinConfig(version)

  log(`3/4 publish the remaining packages`)
  for (const pkg of PACKAGES.slice(1)) await publish(pkg, version)

  log(`4/4 install infra-kit@${version} globally${skipPluginUpdate ? '' : ' and update the plugin in every consumer'}`)
  installGlobal(version)
  if (!skipPluginUpdate) updatePlugins()

  log(`done — ${version} is live. Push the pin commit: git push origin main`)
}

main().catch((error) => {
  fail(error.message)
})
