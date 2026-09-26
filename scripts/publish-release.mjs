#!/usr/bin/env node
// The publish half of the release, run by CI's publish job with `id-token: write` and nothing
// installed: it reads release-artifacts/manifest.json and stages each tarball whose version is not
// on the registry yet. `npm stage publish`, never `npm publish`: the human approves on npmjs.com
// (Staged Packages) or with `npm stage approve`, and that 2FA step is what a hijacked CI cannot
// fake. The trusted publisher on npmjs.com is configured to allow ONLY stage publish.
//
// Every package already live is skipped, so a re-run of a failed job finishes the release instead
// of tripping over its own earlier half. Order is the manifest's (config first).
//
// Env:   DRY_RUN=true   packs nothing extra and runs `npm publish --dry-run` per tarball instead.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, fail, isPublished, log } from './lib/release.mjs'

const OUT_DIR = path.join(REPO_ROOT, 'release-artifacts')
const dryRun = process.env.DRY_RUN === 'true'

const manifestFile = path.join(OUT_DIR, 'manifest.json')
if (!fs.existsSync(manifestFile))
  fail(`${path.relative(REPO_ROOT, manifestFile)} is missing — run scripts/pack-release.mjs first`)
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))

const npm = (cmdArgs) => {
  console.log(`  $ npm ${cmdArgs.join(' ')}`)
  const result = spawnSync('npm', cmdArgs, { cwd: OUT_DIR, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  process.stdout.write(output)
  return { status: result.status, output }
}

log(`${dryRun ? 'dry run' : 'stage'} release: ${manifest.map((entry) => `${entry.name}@${entry.version}`).join(', ')}`)

for (const entry of manifest) {
  const tarball = path.join(OUT_DIR, entry.file)
  if (!fs.existsSync(tarball)) fail(`${entry.file} is missing from ${path.relative(REPO_ROOT, OUT_DIR)}/`)

  if (await isPublished(entry.name, entry.version)) {
    console.log(`  ${entry.name}@${entry.version} is already on the registry — skipping`)
    continue
  }

  if (dryRun) {
    log(`dry run ${entry.name}@${entry.version}`)
    const { status } = npm(['publish', tarball, '--dry-run', '--ignore-scripts', '--access', 'public'])
    if (status !== 0) fail(`npm publish --dry-run failed for ${entry.name}`)
    continue
  }

  log(`stage ${entry.name}@${entry.version}`)
  const { status, output } = npm(['stage', 'publish', tarball, '--ignore-scripts', '--access', 'public'])
  if (status === 0) continue
  // A version this run already staged (a re-run after a later package failed) is not a refusal;
  // anything else is, and the job stops so the registry never sees a partial release unnoticed.
  if (/already|E409|staged/i.test(output)) {
    console.log(`  ${entry.name}@${entry.version} looks already staged — leaving it for approval`)
    continue
  }
  fail(`npm stage publish failed for ${entry.name}@${entry.version}`)
}

log(
  dryRun
    ? 'dry run done — nothing was published'
    : 'staged — approve each package on npmjs.com (Staged Packages) or with `npm stage approve`, config first',
)
