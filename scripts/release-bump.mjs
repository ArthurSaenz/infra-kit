#!/usr/bin/env node
// The release trigger. Moves the six version fields together and commits them; pushing that
// commit to main is what runs .github/workflows/publish.yaml. There is no tag to create and no
// `pnpm publish` to run from a laptop — CI stages, the human approves on npmjs.com.
//
// Usage: node scripts/release-bump.mjs <patch|minor|major|x.y.z>   e.g. minor, 0.12.0
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { REPO_ROOT, VERSION_FIELDS, fail, isPublished, log, resolveVersion } from './lib/release.mjs'

const LEVELS = ['major', 'minor', 'patch']

const bumpLevel = (current, level) => {
  const [major, minor, patch] = current.split(/[.-]/).map(Number)
  if (level === 'major') return `${major + 1}.0.0`
  if (level === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const [arg] = process.argv.slice(2)
const version = LEVELS.includes(arg) ? bumpLevel(resolveVersion(), arg) : arg
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
  fail('usage: node scripts/release-bump.mjs <patch|minor|major|x.y.z>')

const git = (cmdArgs) => {
  console.log(`  $ git ${cmdArgs.join(' ')}`)
  const result = spawnSync('git', cmdArgs, { cwd: REPO_ROOT, stdio: 'inherit' })
  if (result.status !== 0) fail(`git ${cmdArgs.join(' ')} exited ${result.status}`)
}

// Only the six files matter: CI packs from the pushed commit, so unrelated local edits can stay.
const versionPaths = VERSION_FIELDS.map((field) => {
  return path.relative(REPO_ROOT, field.file)
})
const dirty = spawnSync('git', ['status', '--porcelain', '--', ...versionPaths], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).stdout.trim()
if (dirty) fail(`uncommitted changes in the version files — commit or stash them first:\n${dirty}`)

if (await isPublished('infra-kit', version))
  fail(`infra-kit@${version} is already on the registry — pick the next version`)

log(`bump to ${version}`)
const changed = VERSION_FIELDS.filter((field) => {
  const text = fs.readFileSync(field.file, 'utf8')
  const next = field.write(text, version)
  if (next === text) return false
  fs.writeFileSync(field.file, next)
  console.log(`  ${path.relative(REPO_ROOT, field.file)}`)
  return true
})
if (changed.length === 0) fail(`every field already says ${version}`)

git([
  'add',
  ...VERSION_FIELDS.map((field) => {
    return path.relative(REPO_ROOT, field.file)
  }),
])
git(['commit', '-m', `[DO] release ${version}: bump the six version fields`])
log(`committed — now: git push origin main   (CI stages the four packages; approve them on npmjs.com, config first)`)
