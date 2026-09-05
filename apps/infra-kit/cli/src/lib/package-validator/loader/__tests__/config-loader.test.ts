import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { readDeclaredPackageType } from '../config-loader'

/** A temp package directory, optionally holding an `infra-kit.config.ts` with the given source. */
const makePackage = (configSource?: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-kit-declared-type-'))

  if (configSource !== undefined) {
    fs.writeFileSync(path.join(dir, 'infra-kit.config.ts'), configSource, 'utf-8')
  }

  return dir
}

describe('readDeclaredPackageType', () => {
  it('reads a declared type from an object default export', async () => {
    const dir = makePackage("export default { type: 'frontend' }\n")

    expect(await readDeclaredPackageType(dir)).toBe('frontend')
  })

  it('reads a declared type from a factory default export', async () => {
    const dir = makePackage("export default () => ({ type: 'backend', requiredScripts: [] })\n")

    expect(await readDeclaredPackageType(dir)).toBe('backend')
  })

  it.each([
    { label: 'the config declares no type', source: 'export default { requiredScripts: [] }\n' },
    { label: 'the declared type is one this CLI does not know', source: "export default { type: 'quantum' }\n" },
    { label: 'there is no config file at all', source: undefined },
    { label: 'the config file cannot be loaded', source: 'export default {{{ not valid typescript\n' },
  ])('returns undefined, without throwing, when $label', async ({ source }) => {
    expect(await readDeclaredPackageType(makePackage(source))).toBeUndefined()
  })
})
