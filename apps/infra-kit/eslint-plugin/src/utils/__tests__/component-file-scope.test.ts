import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { isInScope, isStoryOrTestFile, isUiPackageFile } from '../component-file-scope'
import { resetPackageRootCache } from '../package-root'
import { resetPackageTypeCache } from '../package-type-reader'

describe('isStoryOrTestFile', () => {
  it.each([
    '/r/src/a/__tests__/a.tsx',
    '/r/src/a/__stories__/a.tsx',
    '/r/src/a/a.stories.tsx',
    '/r/src/a/a.test.tsx',
    '/r/src/a/a.spec.ts',
  ])('matches %s', (filename) => {
    expect(isStoryOrTestFile(filename)).toBe(true)
  })

  it('does not match a component', () => {
    expect(isStoryOrTestFile('/r/src/a/a-component.tsx')).toBe(false)
  })
})

describe('isInScope', () => {
  it('lets ignore win over paths and treats empty paths as everything', () => {
    expect(isInScope('/r/src/features/a/x.tsx', ['**/features/**'], ['**/a/**'])).toBe(false)
    expect(isInScope('/r/src/lib/x.tsx', [], [])).toBe(true)
    expect(isInScope('/r/src/lib/x.tsx', ['**/features/**'], [])).toBe(false)
  })
})

describe('isUiPackageFile', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'component-file-scope-')).split(path.sep).join('/')
    writeFileSync(`${root}/pnpm-workspace.yaml`, "packages:\n  - 'packages/*'\n")

    for (const type of ['frontend', 'backend', 'e2e']) {
      mkdirSync(`${root}/packages/${type}/src`, { recursive: true })
      writeFileSync(`${root}/packages/${type}/package.json`, `{ "name": "${type}" }\n`)
      writeFileSync(`${root}/packages/${type}/infra-kit.config.ts`, `export default { type: '${type}' }\n`)
    }

    resetPackageRootCache()
    resetPackageTypeCache()
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    resetPackageRootCache()
    resetPackageTypeCache()
  })

  it('accepts frontend packages and virtual filenames, rejects backend and e2e', () => {
    expect(isUiPackageFile(`${root}/packages/frontend/src/a-component.tsx`)).toBe(true)
    expect(isUiPackageFile(`${root}/packages/backend/src/a-component.tsx`)).toBe(false)
    expect(isUiPackageFile(`${root}/packages/e2e/src/a-component.tsx`)).toBe(false)
    expect(isUiPackageFile('<input>')).toBe(true)
  })
})
