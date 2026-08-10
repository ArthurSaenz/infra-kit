import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  describeStaleFiles,
  isHotReloadableChange,
  readHandlerEntries,
  resetHandlerEntryCache,
} from 'src/dev/reload-scope'

import { createTempTracker } from './fixtures'

const temp = createTempTracker()

afterEach(() => {
  temp.cleanup()
  // The entry memo is module-level and keyed by absolute path. Two fixtures never collide, but a test
  // that rewrites one app's serverless.yml within the same millisecond could read a stale mtime.
  resetHandlerEntryCache()
})

/** An app dir with a `serverless.yml` declaring `handler: <h>` for each entry, plus the compiled files. */
const makeApp = (handlers: string[]): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ik-reload-scope-'))

  temp.register(dir)

  const yml = ['service: t', 'functions:']

  handlers.forEach((h, i) => {
    yml.push(`  fn${i}:`, `    handler: ${h}`)
  })
  fs.writeFileSync(path.join(dir, 'serverless.yml'), `${yml.join('\n')}\n`)

  return fs.realpathSync(dir)
}

describe('readHandlerEntries', () => {
  it('resolves each serverless.yml handler to the .js file the runtime actually imports', () => {
    const app = makeApp(['dist/handler.ping', 'dist/controllers/orders.list'])

    expect([...readHandlerEntries(app)].sort()).toEqual(
      [path.join(app, 'dist', 'handler.js'), path.join(app, 'dist', 'controllers', 'orders.js')].sort(),
    )
  })

  it('returns an empty set when serverless.yml is missing or malformed', () => {
    const missing = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-reload-scope-')))

    temp.register(missing)
    expect(readHandlerEntries(missing).size).toBe(0)

    const broken = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-reload-scope-')))

    temp.register(broken)
    fs.writeFileSync(path.join(broken, 'serverless.yml'), 'functions: [unclosed\n')
    // Empty is the CONSERVATIVE answer: nothing is vouched for, so the runner warns rather than
    // claiming a reload it cannot back. A throw here would take the whole watch session down.
    expect(readHandlerEntries(broken).size).toBe(0)
  })

  it('re-reads after serverless.yml changes, so a route added mid-session is not missed', () => {
    const app = makeApp(['dist/handler.ping'])

    expect(readHandlerEntries(app).size).toBe(1)

    // A new route lands. The memo is keyed on mtime, so the next read must see it — bumping the
    // timestamp explicitly because a same-millisecond rewrite would otherwise be indistinguishable.
    fs.writeFileSync(
      path.join(app, 'serverless.yml'),
      'service: t\nfunctions:\n  a:\n    handler: dist/handler.ping\n  b:\n    handler: dist/extra.run\n',
    )
    const future = new Date(Date.now() + 2000)

    fs.utimesSync(path.join(app, 'serverless.yml'), future, future)

    expect(readHandlerEntries(app).has(path.join(app, 'dist', 'extra.js'))).toBe(true)
  })
})

describe('isHotReloadableChange', () => {
  it('is true for a handler entry file and false for anything it merely imports', () => {
    const app = makeApp(['dist/handler.ping'])

    // The one file a watch restart re-`import()`s.
    expect(isHotReloadableChange(path.join(app, 'dist', 'handler.js'), app)).toBe(true)

    // A service the handler imports: re-evaluated never, because Node's ESM registry already holds it.
    // This is the case that used to print `✅ Restarted` while serving stale code.
    expect(isHotReloadableChange(path.join(app, 'dist', 'services', 'products.js'), app)).toBe(false)
  })

  it('is false for a shared package dist file, which is never an entry of any app', () => {
    const app = makeApp(['dist/handler.ping'])

    expect(isHotReloadableChange(path.join(app, '..', 'packages', 'shared', 'dist', 'index.js'), app)).toBe(false)
  })
})

describe('describeStaleFiles', () => {
  it('names up to two basenames and collapses the rest into a count', () => {
    expect(describeStaleFiles(['/a/dist/x.js'])).toBe('x.js')
    expect(describeStaleFiles(['/a/dist/x.js', '/a/dist/y.js'])).toBe('x.js, y.js')
    expect(describeStaleFiles(['/a/dist/x.js', '/a/dist/y.js', '/a/dist/z.js'])).toBe('x.js, y.js (+1 more)')
  })
})
