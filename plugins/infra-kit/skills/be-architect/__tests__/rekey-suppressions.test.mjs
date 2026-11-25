import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/rekey-suppressions.mjs', import.meta.url))

let pkg

afterEach(() => {
  if (pkg) rmSync(pkg, { recursive: true, force: true })
  pkg = undefined
})

/** A temp package: `files` exist on disk, `suppressions` is written as eslint-suppressions.json. */
function setup({ files = [], suppressions, map }) {
  pkg = mkdtempSync(join(tmpdir(), 'rekey-'))
  for (const file of files) {
    mkdirSync(dirname(join(pkg, file)), { recursive: true })
    writeFileSync(join(pkg, file), '')
  }
  writeFileSync(join(pkg, 'eslint-suppressions.json'), `${JSON.stringify(suppressions, null, 2)}\n`)
  writeFileSync(join(pkg, 'map.tsv'), map.map((pair) => pair.join('\t')).join('\n'))
}

function run(...extra) {
  return spawnSync(process.execPath, [SCRIPT, pkg, join(pkg, 'map.tsv'), ...extra], { encoding: 'utf8' })
}

function readSuppressions() {
  return JSON.parse(readFileSync(join(pkg, 'eslint-suppressions.json'), 'utf8'))
}

const count = (n) => ({ count: n })

test('rekeys a renamed file and keeps an unrenamed existing file as is', () => {
  setup({
    files: ['src/services/orders/orders.service.ts', 'src/controllers/get-order.ts'],
    suppressions: {
      'src/controllers/get-order.ts': { 'no-console': count(1) },
      'src/services/orders.ts': { 'boundaries/dependencies': count(2) },
    },
    map: [['src/services/orders.ts', 'src/services/orders/orders.service.ts']],
  })

  const result = run()

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readSuppressions(), {
    'src/controllers/get-order.ts': { 'no-console': count(1) },
    'src/services/orders/orders.service.ts': { 'boundaries/dependencies': count(2) },
  })
})

test('a directory entry rekeys every path under it', () => {
  setup({
    files: ['src/controllers/a.ts', 'src/controllers/nested/b.ts'],
    suppressions: {
      'src/lambda_controllers/a.ts': { 'no-console': count(1) },
      'src/lambda_controllers/nested/b.ts': { 'no-console': count(1) },
    },
    map: [['src/lambda_controllers/', 'src/controllers/']],
  })

  assert.equal(run().status, 0)
  assert.deepEqual(Object.keys(readSuppressions()), ['src/controllers/a.ts', 'src/controllers/nested/b.ts'])
})

test('prunes naming-rule entries on renamed paths only, and drops a key left empty', () => {
  setup({
    files: [
      'src/services/orders/order-type.service.ts',
      'src/services/payments/payments.service.ts',
      'src/lib/oldName.ts',
    ],
    suppressions: {
      'src/lib/oldName.ts': { 'unicorn/filename-case': count(1) },
      'src/services/orderType.ts': { 'unicorn/filename-case': count(1), 'no-console': count(3) },
      'src/services/paymentsService.ts': { 'unicorn/filename-case': count(1), 'wl-config/folder-case': count(1) },
    },
    map: [
      ['src/services/orderType.ts', 'src/services/orders/order-type.service.ts'],
      ['src/services/paymentsService.ts', 'src/services/payments/payments.service.ts'],
    ],
  })

  const result = run()

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readSuppressions(), {
    'src/lib/oldName.ts': { 'unicorn/filename-case': count(1) },
    'src/services/orders/order-type.service.ts': { 'no-console': count(3) },
  })
  assert.match(result.stdout, /^unicorn\/filename-case\t3\t1$/m)
  assert.match(result.stdout, /^wl-config\/folder-case\t1\t0$/m)
  assert.match(result.stdout, /^no-console\t3\t3$/m)
})

test('--prune-rules replaces the default naming rules', () => {
  setup({
    files: ['src/services/orders/orders.service.ts'],
    suppressions: { 'src/services/orders.ts': { 'unicorn/filename-case': count(1), 'custom/naming': count(1) } },
    map: [['src/services/orders.ts', 'src/services/orders/orders.service.ts']],
  })

  assert.equal(run('--prune-rules', 'custom/naming').status, 0)
  assert.deepEqual(readSuppressions(), {
    'src/services/orders/orders.service.ts': { 'unicorn/filename-case': count(1) },
  })
})

test('exits non-zero and writes nothing when a key matches neither the map nor a file', () => {
  const suppressions = {
    'src/services/gone.ts': { 'no-console': count(1) },
    'src/services/orders.ts': { 'no-console': count(1) },
  }
  setup({
    files: ['src/services/orders/orders.service.ts'],
    suppressions,
    map: [['src/services/orders.ts', 'src/services/orders/orders.service.ts']],
  })

  const result = run()

  assert.equal(result.status, 1)
  assert.match(result.stderr, /unmatched key .*src\/services\/gone\.ts/)
  assert.deepEqual(readSuppressions(), suppressions)
})

test('exits non-zero when two keys land on one path', () => {
  setup({
    files: ['src/services/orders/orders.service.ts'],
    suppressions: {
      'src/services/orders/orders.service.ts': { 'no-console': count(1) },
      'src/services/orders.ts': { 'no-console': count(1) },
    },
    map: [['src/services/orders.ts', 'src/services/orders/orders.service.ts']],
  })

  const result = run()

  assert.equal(result.status, 1)
  assert.match(result.stderr, /two keys land on one path/)
})

test('never adds an entry: no new keys, rules, or counts beyond the input', () => {
  const suppressions = {
    'src/services/a.ts': { 'no-console': count(2), 'unicorn/filename-case': count(1) },
    'src/services/b.ts': { 'boundaries/dependencies': count(1) },
  }
  setup({
    files: ['src/services/a/a.service.ts', 'src/services/b/b.service.ts', 'src/services/c/c.service.ts'],
    suppressions,
    map: [
      ['src/services/a.ts', 'src/services/a/a.service.ts'],
      ['src/services/b.ts', 'src/services/b/b.service.ts'],
      ['src/services/c.ts', 'src/services/c/c.service.ts'],
    ],
  })

  assert.equal(run().status, 0)
  const after = Object.values(readSuppressions())
  const before = Object.values(suppressions)
  assert.equal(after.length, 2)
  after.forEach((rules, i) => {
    for (const [rule, { count: n }] of Object.entries(rules)) assert.ok(before[i][rule].count >= n)
  })
})

test('--dry-run prints the counts and leaves the file untouched', () => {
  setup({
    files: ['src/services/orders/orders.service.ts'],
    suppressions: { 'src/services/orders.ts': { 'unicorn/filename-case': count(1) } },
    map: [['src/services/orders.ts', 'src/services/orders/orders.service.ts']],
  })
  const original = readFileSync(join(pkg, 'eslint-suppressions.json'), 'utf8')

  const result = run('--dry-run')

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^\[dry-run\]/)
  assert.match(result.stdout, /^unicorn\/filename-case\t1\t0$/m)
  assert.equal(readFileSync(join(pkg, 'eslint-suppressions.json'), 'utf8'), original)
})

test('a malformed map line is a usage error', () => {
  setup({ suppressions: {}, map: [['src/only-one-column.ts']] })

  const result = run()

  assert.equal(result.status, 2)
  assert.match(result.stderr, /expected old<TAB>new/)
})
