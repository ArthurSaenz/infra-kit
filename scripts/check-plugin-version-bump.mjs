#!/usr/bin/env node
// U9 gate (plan §8.1): a diff that touches plugins/infra-kit/** must also change the
// `"version"` line of plugins/infra-kit/.claude-plugin/plugin.json. Without the bump, every
// consumer's cached copy stays on the old version and `/plugin update` reports "already at the
// latest version" (D6-b) — the change would ship to nobody.
//
// Usage: node scripts/check-plugin-version-bump.mjs [<base-ref>]   (default: origin/main)
// Exit 0 when the diff does not touch the plugin, or touches it and bumps the version.
// Exit 1 when the plugin is touched and the version line is unchanged.
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const PLUGIN_DIR = 'plugins/infra-kit/'
const MANIFEST = `${PLUGIN_DIR}.claude-plugin/plugin.json`
const VERSION_LINE = /^[-+]\s*"version"\s*:/m

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })

const baseRef = process.argv[2] ?? 'origin/main'
const changed = git('diff', '--name-only', `${baseRef}...HEAD`)
  .split('\n')
  .filter((line) => line.startsWith(PLUGIN_DIR))

if (changed.length === 0) {
  console.log(`U9: no changes under ${PLUGIN_DIR} — nothing to check`)
  process.exit(0)
}

const manifestDiff = git('diff', `${baseRef}...HEAD`, '--', MANIFEST)
if (VERSION_LINE.test(manifestDiff)) {
  console.log(`U9: ${changed.length} plugin file(s) changed and ${MANIFEST} version line bumped — ok`)
  process.exit(0)
}

console.error(
  `U9: ${changed.length} file(s) changed under ${PLUGIN_DIR} but the "version" line of ${MANIFEST} did not change.`,
)
console.error('Bump the plugin version in the same commit, or consumers never receive this change.')
process.exit(1)
