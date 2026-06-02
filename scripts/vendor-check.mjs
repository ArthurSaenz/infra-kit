// Verifies that files under `vendor/` still match the checksums recorded in
// `vendor/.sync-manifest.json`. Catches accidental local edits to mirrored white-label code
// (which must be edited upstream in starter-workspace, not here). Self-contained: does NOT
// require starter-workspace to be present, so it runs in CI for any consumer repo.
//
// Usage: node devops/scripts/lib/vendor-check.mjs   (exit 0 = clean, exit 1 = drift)
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const VENDOR_DIR = 'vendor'
const MANIFEST_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.turbo',
  '.omc',
  '__screenshots__',
  '.output',
  '.source',
  '.nitro',
  '.tanstack',
])
const MANIFEST_SKIP_FILES = new Set(['.sync-manifest.json', '.eslintcache', 'log.txt'])
const MANIFEST_SKIP_SUFFIXES = ['.tsbuildinfo']

const vendorRoot = join(process.cwd(), VENDOR_DIR)
const manifestPath = join(vendorRoot, '.sync-manifest.json')

if (!existsSync(vendorRoot)) {
  console.log(`ℹ️  No ${VENDOR_DIR}/ folder found — nothing to check.`)
  process.exit(0)
}

if (!existsSync(manifestPath)) {
  console.error(`❌ Missing ${VENDOR_DIR}/.sync-manifest.json. Re-run the white-label sync to generate it.`)
  process.exit(1)
}

const walkFiles = (root, base = root, acc = []) => {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (MANIFEST_SKIP_DIRS.has(entry.name)) continue
      walkFiles(join(root, entry.name), base, acc)
      continue
    }

    if (MANIFEST_SKIP_FILES.has(entry.name)) continue
    if (MANIFEST_SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue

    acc.push(relative(base, join(root, entry.name)))
  }

  return acc
}

const sha256 = (filePath) => createHash('sha256').update(readFileSync(filePath)).digest('hex')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const expected = manifest.files ?? {}
const actualFiles = walkFiles(vendorRoot).sort()

const modified = []
const added = []

for (const rel of actualFiles) {
  if (!(rel in expected)) {
    added.push(rel)
    continue
  }

  if (sha256(join(vendorRoot, rel)) !== expected[rel]) {
    modified.push(rel)
  }
}

const removed = Object.keys(expected).filter((rel) => !actualFiles.includes(rel))

const report = (label, list) => {
  if (!list.length) return
  console.error(`\n${label} (${list.length}):`)
  for (const rel of list.slice(0, 30)) console.error(`  ${rel}`)
  if (list.length > 30) console.error(`  …and ${list.length - 30} more`)
}

if (modified.length || added.length || removed.length) {
  console.error(`❌ ${VENDOR_DIR}/ has drifted from ${VENDOR_DIR}/.sync-manifest.json.`)
  console.error('   These files are mirrored from starter-workspace — edit them upstream, not here.')
  report('Modified', modified)
  report('Added (not in manifest)', added)
  report('Removed (in manifest, now missing)', removed)
  process.exit(1)
}

console.log(`✅ ${VENDOR_DIR}/ matches manifest (${actualFiles.length} files).`)
