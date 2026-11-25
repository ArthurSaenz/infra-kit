import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import type { Options } from '../service-public-api'
import { servicePublicApi } from '../service-public-api'

const BACKEND = 'apps/client/api'
const PAYMENTS = 'services/payments/payment.service.ts'

// The rule reads the package type from `infra-kit.config.ts`, so every case needs a real package.
describe('service-public-api', () => {
  let root: string
  let linter: Linter

  const lint = (relPath: string, code: string, options?: Options, packageDir = BACKEND): Linter.LintMessage[] => {
    const config: Linter.Config = {
      files: ['**/*.ts'],
      plugins: { '@wl': { rules: { 'service-public-api': servicePublicApi } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/service-public-api': options ? ['error', options] : 'error' },
    }

    return linter.verify(code, config, { filename: path.join(root, packageDir, 'src', relPath) })
  }

  const messageIdsOf = (relPath: string, code: string, options?: Options): (string | null | undefined)[] => {
    return lint(relPath, code, options).map((message) => {
      return message.messageId
    })
  }

  const makePackage = (dir: string, type: string): void => {
    mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, dir, 'package.json'), `{ "name": "${type}" }\n`)
    writeFileSync(path.join(root, dir, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'service-public-api-'))
    linter = new Linter({ cwd: root })

    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*/*'\n")
    writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')
    makePackage(BACKEND, 'backend')
    makePackage('apps/client/ui', 'frontend')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    resetPackageRootCache()
    resetPackageTypeCache()
  })

  describe('deepImport (AC 4)', () => {
    it.each([
      "import { OrderService } from '#root/services/orders/order.service.js'",
      "import { OrderService } from '../services/orders/order.service.js'",
      "import type { Order } from '#root/services/orders/types.js'",
      "import type { Order } from '../services/orders/types.js'",
      "type Orders = typeof import('../services/orders/order.service.js')",
    ])('reports from a controller: %s', (code) => {
      expect(messageIdsOf('controllers/orders.ts', code)).toEqual(['deepImport'])
    })

    it('names the domain and its public API', () => {
      expect(
        lint('controllers/orders.ts', "import { OrderService } from '../services/orders/order.service.js'")[0]?.message,
      ).toBe(
        '`../services/orders/order.service.js` reaches into the internals of domain `orders`. Import from its public API `#root/services/orders` instead, exporting what you need from `services/orders/index.ts`. See /infra-kit:be-architect for the backend import rules.',
      )
    })

    it('reports a type-only deep import from a sibling domain without crossDomainRuntime', () => {
      expect(messageIdsOf(PAYMENTS, "import type { Order } from '../orders/types.js'")).toEqual(['deepImport'])
    })

    it('reports a value deep import from a sibling domain under both ids', () => {
      expect(messageIdsOf(PAYMENTS, "import { OrderService } from '../orders/order.service.js'")).toEqual([
        'deepImport',
        'crossDomainRuntime',
      ])
    })

    it.each([
      "import { OrderService } from '#root/services/orders'",
      "import { OrderService } from '#root/services/orders/index.js'",
      "import { OrderService } from '../services/orders/index.ts'",
      "import { OrderService } from '../services/orders'",
    ])('accepts the public API from a controller: %s', (code) => {
      expect(lint('controllers/orders.ts', code)).toEqual([])
    })
  })

  describe('crossDomainRuntime (AC 5)', () => {
    it.each([
      ['a value import', "import { OrderService } from '../orders/index.js'"],
      ['an alias value import', "import { OrderService } from '#root/services/orders'"],
      ['mixed inline specifiers', "import { type Order, OrderService } from '../orders/index.js'"],
      ['a side-effect import', "import '../orders/index.js'"],
      ['a dynamic import', "const orders = await import('../orders/index.js')"],
      ['export * from', "export * from '../orders/index.js'"],
      ['export { a } from', "export { OrderService } from '../orders/index.js'"],
      ['import = require', "import orders = require('../orders/index.js')"],
    ])('reports %s', (_label, code) => {
      expect(messageIdsOf(PAYMENTS, code)).toEqual(['crossDomainRuntime'])
    })

    it('reports a value import from a domain test file, with no test exemption', () => {
      expect(
        messageIdsOf('services/payments/__tests__/x.test.ts', "import { OrderService } from '../../orders/index.js'"),
      ).toEqual(['crossDomainRuntime'])
    })

    it('names both domains', () => {
      expect(lint(PAYMENTS, "import { OrderService } from '../orders/index.js'")[0]?.message).toBe(
        '`../orders/index.js` imports domain `orders` at runtime from domain `payments`. Domains share only types (`import type`); compose services in a controller instead. See /infra-kit:be-architect for the backend import rules.',
      )
    })

    it.each([
      ['import type', "import type { Order } from '../orders/index.js'"],
      ['export type from', "export type { Order } from '../orders/index.js'"],
      ['all-inline type specifiers', "import { type Order, type OrderStatus } from '../orders/index.js'"],
      ['typeof import', "type Orders = typeof import('../orders/index.js')"],
      ['import type = require', "import type orders = require('../orders/index.js')"],
      ['a same-domain relative import', "import { fee } from './lib/fee.js'"],
      ['a src/lib import', "import { BaseService } from '../../lib/base-service.js'"],
      ['a package import', "import { z } from 'zod'"],
    ])('accepts %s', (_label, code) => {
      expect(lint(PAYMENTS, code)).toEqual([])
    })

    it('accepts a domain test importing its own domain', () => {
      expect(
        lint('services/payments/__tests__/x.test.ts', "import { PaymentService } from '../payment.service.js'"),
      ).toEqual([])
    })
  })

  describe('libRuntimeImport', () => {
    it('reports a src/lib file value-importing a domain', () => {
      const [message] = lint('lib/a.ts', "import { OrderService } from '../services/orders/index.js'")

      expect(message?.messageId).toBe('libRuntimeImport')
      expect(message?.message).toBe(
        '`../services/orders/index.js` imports domain `orders` at runtime from `src/lib/`, which must stay domain-free. Move the code into the domain, or import only types (`import type`). See /infra-kit:be-architect for the backend import rules.',
      )
    })

    it('reports a deep value import from src/lib under both ids', () => {
      expect(messageIdsOf('lib/a.ts', "import { shared } from '../services/catalog-filters/shared.js'")).toEqual([
        'deepImport',
        'libRuntimeImport',
      ])
    })

    it('accepts a type-only import from src/lib', () => {
      expect(lint('lib/a.ts', "import type { Order } from '../services/orders/index.js'")).toEqual([])
    })

    it('accepts a file matched by libRuntimeAllow', () => {
      const options: Options = { libRuntimeAllow: ['**/src/lib/container/**'] }

      expect(
        lint('lib/container/bootstrap.ts', "import { OrderService } from '../../services/orders/index.js'", options),
      ).toEqual([])
      expect(messageIdsOf('lib/a.ts', "import { OrderService } from '../services/orders/index.js'", options)).toEqual([
        'libRuntimeImport',
      ])
    })

    it('leaves controllers free to import domains at runtime', () => {
      expect(lint('controllers/orders.ts', "import { OrderService } from '../services/orders/index.js'")).toEqual([])
    })
  })

  it('is silent in a frontend package', () => {
    const code = "import { OrderService } from '../orders/order.service.js'"

    expect(lint(PAYMENTS, code, undefined, 'apps/client/ui')).toEqual([])
    expect(lint('lib/a.ts', "import { x } from '../services/orders/index.js'", undefined, 'apps/client/ui')).toEqual([])
  })

  it('skips files matching ignore', () => {
    expect(lint(PAYMENTS, "import { OrderService } from '../orders/index.js'", { ignore: ['**/payments/**'] })).toEqual(
      [],
    )
  })
})
