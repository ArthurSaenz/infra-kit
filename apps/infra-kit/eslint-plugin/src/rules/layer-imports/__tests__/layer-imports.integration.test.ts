import tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import type { Options } from '../layer-imports'
import { layerImports } from '../layer-imports'

const BACKEND = 'apps/client/api'

// The default levels depend on the package type, which is read from disk.
describe('layer-imports by package type', () => {
  let root: string
  let linter: Linter

  const lint = (relPath: string, code: string, options?: Options, packageDir = BACKEND): Linter.LintMessage[] => {
    const config: Linter.Config = {
      files: ['**/*.ts'],
      plugins: { '@wl': { rules: { 'layer-imports': layerImports } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/layer-imports': options ? ['error', options] : 'error' },
    }

    return linter.verify(code, config, { filename: path.join(root, packageDir, 'src', relPath) })
  }

  const makePackage = (dir: string, type: string): void => {
    mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, dir, 'package.json'), `{ "name": "${type}" }\n`)
    writeFileSync(path.join(root, dir, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'layer-imports-'))
    linter = new Linter({ cwd: root })

    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*/*'\n")
    writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')
    makePackage(BACKEND, 'backend')
    makePackage('apps/client/tests', 'e2e')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    resetPackageRootCache()
    resetPackageTypeCache()
  })

  it.each([
    ['services/orders/order.service.ts', "import { handler } from '#root/controllers/orders.js'"],
    ['services/orders/order.service.ts', "import { handler } from '../../controllers/orders.js'"],
    ['lib/a.ts', "import { handler } from '../controllers/orders.js'"],
    ['config/a.ts', "const orders = await import('../controllers/orders.js')"],
  ])('reports a backend %s importing a controller', (relPath, code) => {
    expect(
      lint(relPath, code).map((message) => {
        return message.messageId
      }),
    ).toEqual(['upward'])
  })

  it('spells out the backend order', () => {
    expect(lint('lib/a.ts', "import { handler } from '../controllers/orders.js'")[0]?.message).toBe(
      '`lib` cannot import `../controllers/orders.js` from the higher layer `controllers`. Layers import only their own level or below: lib, config, services → controllers. Move the shared code down into a lower layer, or pass it in from above.',
    )
  })

  it.each([
    ['controllers/orders.ts', "import { OrderService } from '../services/orders/index.js'"],
    ['controllers/orders.ts', "import { compose } from './composition/orders.js'"],
    ['services/orders/order.service.ts', "import { BaseService } from '../../lib/base-service.js'"],
    ['services/orders/order.service.ts', "import type { Handler } from '../../controllers/orders.js'"],
    // `service-public-api` owns this edge, with its `libRuntimeAllow` escape.
    ['lib/container/bootstrap.ts', "import { OrderService } from '../../services/orders/index.js'"],
    ['__tests__/integration/orders.test.ts', "import { handler } from '../../controllers/orders.js'"],
  ])('accepts a backend %s: %s', (relPath, code) => {
    expect(lint(relPath, code)).toEqual([])
  })

  it('lets `layers` replace the backend levels', () => {
    const options: Options = { layers: [['libs'], ['services'], ['lambda_controllers']] }

    expect(lint('libs/a.ts', "import { x } from '../services/orders/index.js'", options)).toHaveLength(1)
    expect(lint('lib/a.ts', "import { handler } from '../controllers/orders.js'", options)).toEqual([])
  })

  it('stays silent in an e2e package', () => {
    expect(lint('lib/a.ts', "import { x } from '../app/x'", undefined, 'apps/client/tests')).toEqual([])
  })
})
