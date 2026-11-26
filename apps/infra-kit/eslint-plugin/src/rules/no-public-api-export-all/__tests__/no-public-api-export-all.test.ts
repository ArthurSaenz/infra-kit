import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import type { Options } from '../no-public-api-export-all'
import { noPublicApiExportAll } from '../no-public-api-export-all'

const UI = 'apps/client/ui'
const API = 'apps/client/api'

// The rule tells a feature from a backend domain by the package type, which is read from disk.
describe('no-public-api-export-all', () => {
  let root: string
  let linter: Linter

  const lint = (packageDir: string, relPath: string, code: string, options?: Options): Linter.LintMessage[] => {
    const config: Linter.Config = {
      files: ['**/*.{ts,tsx}'],
      plugins: { '@wl': { rules: { 'no-public-api-export-all': noPublicApiExportAll } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/no-public-api-export-all': options ? ['error', options] : 'error' },
    }

    return linter.verify(code, config, { filename: path.join(root, packageDir, 'src', relPath) })
  }

  const makePackage = (dir: string, type: string): void => {
    mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, dir, 'package.json'), `{ "name": "${type}" }\n`)
    writeFileSync(path.join(root, dir, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'no-public-api-export-all-'))
    linter = new Linter({ cwd: root })

    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*/*'\n  - 'packages/*'\n")
    writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')
    makePackage(UI, 'frontend')
    makePackage(API, 'backend')
    makePackage('packages/widget', 'lib')
    makePackage('apps/client/tests', 'e2e')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    resetPackageRootCache()
    resetPackageTypeCache()
  })

  describe('feature index', () => {
    it('reports `export * from` with both replacements', () => {
      expect(lint(UI, 'features/daily-deals/index.ts', "export * from './services'")[0]?.message).toBe(
        "`export * from './services'` makes every export of that module part of the public API of feature `daily-deals`. Name the exports (`export { A } from './services'`), or publish the module under one name (`export * as dailyDealsService from './services'`). See /infra-kit:fe-architect for the feature public API.",
      )
    })

    it.each(['index.ts', 'index.tsx'])('reports in %s', (file) => {
      expect(lint(UI, `features/login/${file}`, "export * from './icons'")).toHaveLength(1)
    })

    it('reports in a lib package', () => {
      expect(lint('packages/widget', 'features/prices/index.ts', "export * from './types'")).toHaveLength(1)
    })

    it.each([
      "export * as dailyDealsService from './services'",
      "export { DailyDealContainer } from './containers/daily-deal-container'",
      "export type { DailyDeal } from './types'",
      "export type * from './types'",
      "export type * as dailyDealTypes from './types'",
    ])('accepts %s', (code) => {
      expect(lint(UI, 'features/daily-deals/index.ts', code)).toEqual([])
    })

    it.each([
      'features/daily-deals/services/index.ts',
      'features/daily-deals/services.ts',
      'components/default/icons/index.ts',
      'lib/dates/index.ts',
      'services/orders/index.ts',
    ])('leaves %s alone', (relPath) => {
      expect(lint(UI, relPath, "export * from './x'")).toEqual([])
    })
  })

  describe('backend domain index', () => {
    it('reports `export * from` with both replacements', () => {
      expect(lint(API, 'services/orders/index.ts', "export * from './order.service.js'")[0]?.message).toBe(
        "`export * from './order.service.js'` makes every export of that module part of the public API of domain `orders`. Name the exports (`export { A } from './order.service.js'`), or publish the module under one name (`export * as orders from './order.service.js'`). See /infra-kit:be-architect for the backend service layout.",
      )
    })

    it('reports each star export', () => {
      const code = "export * from './a.service.js'\nexport * from './b.service.js'\nexport type * from './types.js'"

      expect(lint(API, 'services/orders/index.ts', code)).toHaveLength(2)
    })

    it.each([
      "export { OrderService } from './order.service.js'",
      "export * as orders from './order.service.js'",
      "export type * from './types.js'",
    ])('accepts %s', (code) => {
      expect(lint(API, 'services/orders/index.ts', code)).toEqual([])
    })

    it.each([
      'services/orders/lib/index.ts',
      'services/orders/order.service.ts',
      'lib/index.ts',
      'features/a/index.ts',
    ])('leaves %s alone', (relPath) => {
      expect(lint(API, relPath, "export * from './x.js'")).toEqual([])
    })
  })

  it('is silent in an e2e package', () => {
    expect(lint('apps/client/tests', 'features/a/index.ts', "export * from './x'")).toEqual([])
  })

  it('skips files matching ignore', () => {
    expect(lint(UI, 'features/login/index.ts', "export * from './icons'", { ignore: ['**/login/**'] })).toEqual([])
  })
})
