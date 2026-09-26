#!/usr/bin/env node
// The build half of the release: builds the four packages and packs them into release-artifacts/,
// in publish order, with the manifest npm will receive checked before anything leaves this job.
// The publish job downloads that directory and never installs a dependency — every tool that runs
// next to `id-token: write` could publish in our name, so the tarballs are finished here.
//
// Usage: node scripts/pack-release.mjs   (CI's build job; also fine locally to inspect a tarball)
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { PACKAGES, REPO_ROOT, fail, log, resolveVersion } from './lib/release.mjs'

const OUT_DIR = path.join(REPO_ROOT, 'release-artifacts')

const run = (cmd, cmdArgs, cwd) => {
  console.log(
    `  $ ${[cmd, ...cmdArgs].join(' ')}${cwd === REPO_ROOT ? '' : `   (in ${path.relative(REPO_ROOT, cwd)})`}`,
  )
  const result = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit' })
  if (result.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} exited ${result.status}`)
}

/**
 * `catalog:` and `workspace:` ranges have leaked into published runtime deps before
 * (`catalogMode: manual` does not prevent it) and a consumer install then fails on a protocol npm
 * does not know. `workspace:^` is fine in the SOURCE manifest: `pnpm pack` rewrites it to `^x.y.z`,
 * and this check reads the packed manifest, which is the one that ships.
 */
const assertManifestClean = (pkg, tarball, version) => {
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  if (manifest.name !== pkg.name) fail(`${tarball}: tarball is ${manifest.name}, expected ${pkg.name}`)
  if (manifest.version !== version) fail(`${pkg.name}: tarball says ${manifest.version}, tree says ${version}`)
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (/^(catalog|workspace|link|file):/.test(range)) {
        fail(`${pkg.name}: ${field}.${dep} = "${range}" would ship in the tarball — fix the range before releasing`)
      }
    }
  }
}

const version = resolveVersion()
log(`pack release ${version}`)

fs.rmSync(OUT_DIR, { recursive: true, force: true })
fs.mkdirSync(OUT_DIR)

// turbo builds the dependency closure once; `pnpm pack` then runs each package's own `prepack`
// (its build) again — cheap, and it keeps the tarball identical to what a manual pack would ship.
run(
  'pnpm',
  [
    'exec',
    'turbo',
    'run',
    'build',
    ...PACKAGES.map((pkg) => {
      return `--filter=${pkg.name}`
    }),
  ],
  REPO_ROOT,
)

const manifest = []
for (const pkg of PACKAGES) {
  log(`pack ${pkg.name}@${version}`)
  const before = new Set(fs.readdirSync(OUT_DIR))
  run('pnpm', ['pack', '--pack-destination', OUT_DIR], pkg.dir)
  const file = fs.readdirSync(OUT_DIR).find((entry) => {
    return entry.endsWith('.tgz') && !before.has(entry)
  })
  if (!file) fail(`pnpm pack produced no tarball for ${pkg.name}`)
  assertManifestClean(pkg, path.join(OUT_DIR, file), version)
  manifest.push({ name: pkg.name, version, file })
}

fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
log(`packed ${manifest.length} tarballs into ${path.relative(REPO_ROOT, OUT_DIR)}/`)
for (const entry of manifest) console.log(`  ${entry.file}`)
