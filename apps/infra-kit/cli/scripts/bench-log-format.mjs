/**
 * Hand-run gate for the dev log formatter (`src/dev/log-format.ts`): `node scripts/bench-log-format.mjs`.
 * Not part of qa — timings depend on the machine. Fails (exit 1) when the median cost per line exceeds the
 * plan's budget: 2 µs for a plain line, 10 µs for a backend JSON line. A miss means a design change, not a
 * looser number.
 *
 * The formatter is bundled on the fly and imported from a `data:` URL: bundling resolves the `src/*` alias
 * and the `.js` specifiers, which Node's type stripping alone does not.
 */
import * as esbuild from 'esbuild'
import { Buffer } from 'node:buffer'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const LINES_PER_ROUND = 100_000
const ROUNDS = 10

const GATES_US = { plain: 2, json: 10 }

// Allocated once, outside the timed region.
const ROUND_SLOTS = Array.from({ length: ROUNDS })
const LINE_SLOTS = Array.from({ length: LINES_PER_ROUND })

const bundle = await esbuild.build({
  entryPoints: [resolve(PKG_DIR, 'src/dev/log-format.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  absWorkingDir: PKG_DIR,
  logLevel: 'error',
})

const { createLogLineFormatter } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

const format = createLogLineFormatter()

const CASES = {
  plain: ['client/ui', '  ➜  Local:   http://localhost:5173/ (ready in 384 ms, hmr connected)', 'info'],
  json: [
    'client/api',
    JSON.stringify({
      level: 'INFO',
      message: 'order placed',
      service: 'orders',
      timestamp: new Date().toISOString(),
      requestId: 'c0ffee00-1234-4bcd-9abc-0123456789ab',
      orderId: 4211,
      durationMs: 12.5,
    }),
    'info',
  ],
  turbo: ['turbo', 'client-ui:dev: 10:00:00 AM [vite] page reload src/App.tsx', undefined],
}

/** Median of the per-round mean cost, in µs per line. */
const measure = ([service, text, level]) => {
  let bytes = 0
  const perLine = []

  for (const _round of ROUND_SLOTS) {
    const start = process.hrtime.bigint()

    for (const _line of LINE_SLOTS) bytes += format(service, text, level).length

    perLine.push(Number(process.hrtime.bigint() - start) / 1000 / LINES_PER_ROUND)
  }

  perLine.sort((a, b) => {
    return a - b
  })

  // `bytes` keeps the formatter's output observable, so the loop cannot be optimised away.
  if (bytes === 0) throw new Error('formatter produced nothing')

  return perLine[Math.floor(ROUNDS / 2)]
}

// One warm-up pass so the gated rounds measure optimised code, not the interpreter.
for (const input of Object.values(CASES)) measure(input)

let failed = false

for (const [name, input] of Object.entries(CASES)) {
  const median = measure(input)
  const gate = GATES_US[name]
  const verdict = gate == null ? 'info' : median <= gate ? 'pass' : 'FAIL'

  if (verdict === 'FAIL') failed = true
  console.log(
    `${name.padEnd(6)} median ${median.toFixed(3)} µs/line over ${ROUNDS} × ${LINES_PER_ROUND} lines${gate == null ? '' : ` (gate ≤ ${gate} µs)`} ${verdict}`,
  )
}

process.exitCode = failed ? 1 : 0
