#!/usr/bin/env node
// The laptop half that CI cannot do: once a release is approved and live, install the new CLI
// globally and update the Claude Code plugin in every repo that has it installed. Both steps are
// re-runnable; run it after `npm stage approve` has landed all four packages.
//
// Usage: node scripts/release-install.mjs [--skip-plugin-update]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { REPO_ROOT, fail, isPublished, log, resolveVersion } from './lib/release.mjs'

const skipPluginUpdate = process.argv.includes('--skip-plugin-update')

const run = (cmd, cmdArgs, cwd) => {
  console.log(`  $ ${[cmd, ...cmdArgs].join(' ')}${cwd === REPO_ROOT ? '' : `   (in ${cwd})`}`)
  const result = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} exited ${result.status}`)
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

const version = resolveVersion()
if (!(await isPublished('infra-kit', version))) {
  fail(`infra-kit@${version} is not on the registry yet — approve the staged release first`)
}

log(`install infra-kit@${version} globally`)
// Exact version, not `@latest`: pnpm serves the dist-tag from a metadata cache it never revalidates.
run('pnpm', ['add', '-g', `infra-kit@${version}`], REPO_ROOT)

if (!skipPluginUpdate) {
  log('update the plugin in every consumer')
  const failures = []
  for (const dir of pluginConsumers()) {
    try {
      run('claude', ['plugin', 'update', 'infra-kit@infra-kit', '--scope', 'project'], dir)
    } catch (error) {
      failures.push(`${path.basename(dir)}: ${error.message}`)
    }
  }
  if (failures.length > 0) console.log(`  ⚠ plugin update failed in:\n    ${failures.join('\n    ')}`)
}
log('done')
