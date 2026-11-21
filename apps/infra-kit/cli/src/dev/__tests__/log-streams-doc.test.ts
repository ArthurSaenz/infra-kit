import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

/** The services `log-streams.test.ts` drives through their real seams, with the file each one writes. */
const COVERED_SERVICES = [
  ['runner', 'runner.log'],
  ['<app>/api', '<app>-api.log'],
  ['<app>/ui', '<app>-ui.log'],
  ['turbo', 'turbo.log'],
  ['watch', 'watch.log'],
] as const

const DOC = path.resolve(import.meta.dirname, '../../../../../../docs/dev-log-streams.md')

describe('docs/dev-log-streams.md', () => {
  const doc = fs.readFileSync(DOC, 'utf-8')

  it.each(COVERED_SERVICES)('names the `%s` service and its `%s` file', (service, file) => {
    expect(doc).toContain(`(\`${service}\`)`)
    expect(doc).toContain(`\`${file}\``)
  })

  it('covers the capped notice', () => {
    expect(doc).toContain('`[capped]`')
  })
})
