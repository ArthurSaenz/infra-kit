#!/usr/bin/env node
// Re-keys a package's eslint-suppressions.json after a map-driven rename.
//
//   rekey-suppressions.mjs <package-dir> <rename-map.tsv> [--dry-run] [--prune-rules <id,id,…>]
//                          [--suppressions <file>]
//
// The map is `old<TAB>new` per line, paths relative to <package-dir>; an entry ending in `/` renames a
// whole directory. It is the same map that drove the `git mv` calls, not a `git diff -M` guess, which
// can pair the wrong files. Naming-rule entries on renamed paths are pruned because the rename is what
// fixes them, and ESLint fails on unused bulk suppressions. Exit 1 (nothing written) when a key
// matches neither a map entry nor an existing file, or two keys land on one path; exit 2 on bad usage.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DEFAULT_PRUNE_RULES = ['unicorn/filename-case', 'wl-config/folder-case']

function usage(message) {
  console.error(`rekey-suppressions: ${message}`)
  console.error(
    'usage: rekey-suppressions.mjs <package-dir> <rename-map.tsv> [--dry-run] [--prune-rules <id,…>] [--suppressions <file>]',
  )
  process.exit(2)
}

function parseArgs(argv) {
  const positional = []
  const options = { dryRun: false, pruneRules: DEFAULT_PRUNE_RULES, suppressions: 'eslint-suppressions.json' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--prune-rules' || arg === '--suppressions') {
      const value = argv[(i += 1)]
      if (value === undefined) usage(`${arg} needs a value`)
      if (arg === '--suppressions') options.suppressions = value
      else
        options.pruneRules = value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
    } else if (arg.startsWith('-')) usage(`unknown option ${arg}`)
    else positional.push(arg)
  }
  if (positional.length !== 2) usage('expected <package-dir> and <rename-map.tsv>')
  return { packageDir: resolve(positional[0]), mapFile: resolve(positional[1]), ...options }
}

function readMap(mapFile) {
  const files = new Map()
  const dirs = []
  readFileSync(mapFile, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim() === '' || line.startsWith('#')) return
      const fields = line.replace(/\r$/, '').split('\t')
      if (fields.length !== 2 || !fields[0] || !fields[1]) usage(`${mapFile}:${index + 1}: expected old<TAB>new`)
      const [from, to] = fields
      if (from.endsWith('/') !== to.endsWith('/'))
        usage(`${mapFile}:${index + 1}: a directory entry ends in / on both sides`)
      if (files.has(from) || dirs.some((d) => d.from === from))
        usage(`${mapFile}:${index + 1}: ${from} is mapped twice`)
      if (from.endsWith('/')) dirs.push({ from, to })
      else files.set(from, to)
    })
  // Longest prefix first, so a nested directory entry beats its parent's.
  dirs.sort((a, b) => b.from.length - a.from.length)
  return { files, dirs }
}

function mapPath(map, key) {
  if (map.files.has(key)) return map.files.get(key)
  const dir = map.dirs.find((d) => key.startsWith(d.from))
  return dir ? dir.to + key.slice(dir.from.length) : undefined
}

function countByRule(suppressions) {
  const counts = new Map()
  for (const rules of Object.values(suppressions)) {
    for (const [rule, { count }] of Object.entries(rules)) counts.set(rule, (counts.get(rule) ?? 0) + count)
  }
  return counts
}

function isSorted(keys) {
  return keys.every((key, i) => i === 0 || keys[i - 1] <= key)
}

const args = parseArgs(process.argv.slice(2))
const suppressionsFile = join(args.packageDir, args.suppressions)
if (!existsSync(suppressionsFile)) usage(`${suppressionsFile} does not exist`)
const map = readMap(args.mapFile)
const pruneRules = new Set(args.pruneRules)
const raw = readFileSync(suppressionsFile, 'utf8')
const before = JSON.parse(raw)

const after = {}
const unmatched = []
const collisions = []
let renamedKeys = 0
for (const [key, rules] of Object.entries(before)) {
  const target = mapPath(map, key)
  if (target === undefined && !existsSync(join(args.packageDir, key))) {
    unmatched.push(key)
    continue
  }
  const kept =
    target === undefined ? rules : Object.fromEntries(Object.entries(rules).filter(([rule]) => !pruneRules.has(rule)))
  if (target !== undefined) renamedKeys += 1
  const newKey = target ?? key
  if (newKey in after) collisions.push(newKey)
  if (Object.keys(kept).length > 0) after[newKey] = kept
}

if (unmatched.length > 0 || collisions.length > 0) {
  for (const key of unmatched) console.error(`unmatched key (not in the map, file does not exist): ${key}`)
  for (const key of collisions) console.error(`two keys land on one path: ${key}`)
  console.error('rekey-suppressions: nothing written')
  process.exit(1)
}

const ordered = isSorted(Object.keys(before))
  ? Object.fromEntries(
      Object.keys(after)
        .sort()
        .map((key) => [key, after[key]]),
    )
  : after

const beforeCounts = countByRule(before)
const afterCounts = countByRule(ordered)
console.log(`${args.dryRun ? '[dry-run] ' : ''}${suppressionsFile}: ${renamedKeys} key(s) renamed`)
console.log('rule\tbefore\tafter')
for (const rule of [...beforeCounts.keys()].sort()) {
  console.log(`${rule}\t${beforeCounts.get(rule)}\t${afterCounts.get(rule) ?? 0}`)
}

if (!args.dryRun) {
  writeFileSync(suppressionsFile, JSON.stringify(ordered, null, 2) + (raw.endsWith('\n') ? '\n' : ''))
}
