import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import type { Options } from '../service-files'
import { serviceFiles } from '../service-files'

const BACKEND = 'apps/client/api'
const code = 'export const a = 1\n'

// The rule reads the package type from `infra-kit.config.ts` and looks for `index.ts` on disk, so
// every case needs a real package.
describe('service-files', () => {
  let root: string
  let linter: Linter

  const lint = (relPath: string, options?: Options, packageDir = BACKEND): Linter.LintMessage[] => {
    const config: Linter.Config = {
      files: ['**/*.{ts,js}'],
      plugins: { '@wl': { rules: { 'service-files': serviceFiles } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/service-files': options ? ['error', options] : 'error' },
    }

    return linter.verify(code, config, { filename: path.join(root, packageDir, 'src', relPath) })
  }

  const messageIdsOf = (relPath: string, options?: Options, packageDir?: string): (string | null | undefined)[] => {
    return lint(relPath, options, packageDir).map((message) => {
      return message.messageId
    })
  }

  const makePackage = (dir: string, type: string): void => {
    mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, dir, 'package.json'), `{ "name": "${type}" }\n`)
    writeFileSync(path.join(root, dir, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
  }

  const writeSource = (relPath: string): void => {
    const file = path.join(root, BACKEND, 'src', relPath)

    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, code)
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'service-files-'))
    linter = new Linter({ cwd: root })

    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*/*'\n  - 'packages/*'\n")
    writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')
    makePackage(BACKEND, 'backend')
    makePackage('apps/client/ui', 'frontend')
    makePackage('packages/utils', 'lib')
    writeSource('services/orders/index.ts')
    writeSource('services/payments/index.js')
    mkdirSync(path.join(root, BACKEND, 'src/services/seed-validation'), { recursive: true })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    resetPackageRootCache()
    resetPackageTypeCache()
  })

  it.each([
    'services/orders/index.ts',
    'services/orders/order.service.ts',
    'services/orders/order-type.service.ts',
    'services/orders/order2.service.js',
    'services/orders/types.ts',
    'services/orders/constants.ts',
    'services/orders/lib/anyName_here.ts',
    'services/orders/lib/deep/x.ts',
    'services/orders/__tests__/order.service.test.ts',
    'services/orders/__tests__/fixtures/orderFixture.ts',
    'services/payments/payment.service.ts',
    'services/globals.d.ts',
    'services/orders/legacy.d.ts',
    'controllers/orders.ts',
    'lib/base-service.ts',
    'index.ts',
  ])('accepts %s', (relPath) => {
    expect(lint(relPath)).toEqual([])
  })

  it('rejects a domain folder without index.ts (AC 1)', () => {
    const [message] = lint('services/seed-validation/seed-validation.service.ts')

    expect(message?.messageId).toBe('missingIndex')
    expect(message?.message).toBe(
      "Domain `seed-validation` has no `index.ts`. Add `services/seed-validation/index.ts`: it is the domain's public API and the only entry from outside. See /infra-kit:be-architect for the backend service layout.",
    )
  })

  it.each(['services/seed-validation/lib/x.ts', 'services/seed-validation/__tests__/a.test.ts'])(
    'reports the missing index from a nested file: %s',
    (relPath) => {
      expect(messageIdsOf(relPath)).toEqual(['missingIndex'])
    },
  )

  it('reports a wrong name and the missing index together', () => {
    expect(messageIdsOf('services/seed-validation/client.ts')).toEqual(['unknownFile', 'missingIndex'])
  })

  it.each([
    'services/orders/client.ts',
    'services/orders/chats.types.ts',
    'services/orders/x.repository.ts',
    'services/orders/orderType.service.ts',
    'services/orders/order_type.service.ts',
    'services/orders/.service.ts',
    'services/orders/order.service.test.ts',
  ])('rejects a non-allowlisted domain file (AC 2): %s', (relPath) => {
    expect(messageIdsOf(relPath)).toEqual(['unknownFile'])
  })

  it('names the file and domain in unknownFile', () => {
    expect(lint('services/orders/client.ts')[0]?.message).toBe(
      '`client.ts` is not an allowed file in domain `orders`. Allowed: index.ts, <kebab-name>.service.ts, types.ts, constants.ts; helpers go in `lib/`, tests in `__tests__/`. See /infra-kit:be-architect for the backend service layout.',
    )
  })

  it.each(['services/orders.ts', 'services/index.ts', 'services/julyoServiceOrderStack.js'])(
    'rejects a flat file in services/ (AC 3): %s',
    (relPath) => {
      expect(messageIdsOf(relPath)).toEqual(['flatFile'])
    },
  )

  it('tells a flat file to move into a domain folder', () => {
    expect(lint('services/orders.ts')[0]?.message).toBe(
      "`orders.ts` sits directly in `services/`. Every service lives in a domain folder: move it to `services/<domain>/` and expose it through that folder's `index.ts`. See /infra-kit:be-architect for the backend service layout.",
    )
  })

  it.each(['services/__tests__/a.test.ts', 'services/__tests__/fixtures/x.ts'])(
    'rejects services/__tests__/: %s',
    (relPath) => {
      expect(messageIdsOf(relPath)).toEqual(['testsOutsideDomain'])
    },
  )

  it.each([
    ['frontend', 'apps/client/ui'],
    ['lib', 'packages/utils'],
  ])('is silent in a %s package', (_type, packageDir) => {
    expect(lint('services/orders.ts', undefined, packageDir)).toEqual([])
    expect(lint('services/__tests__/a.test.ts', undefined, packageDir)).toEqual([])
    expect(lint('services/no-index/client.ts', undefined, packageDir)).toEqual([])
  })

  it('skips files matching ignore', () => {
    expect(lint('services/orders.ts', { ignore: ['**/services/orders.ts'] })).toEqual([])
  })
})
