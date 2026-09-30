import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { resetPackageRootCache } from '../utils/package-root'
import { resetPackageTypeCache } from '../utils/package-type-reader'

export interface E2eWorkspace {
  root: string
  /** An absolute filename under `apps/shop/tests/src/tests/checkout/` (an e2e package), or under `packageDir`. */
  fileIn: (file: string, packageDir?: string) => string
  dispose: () => void
}

/**
 * A throwaway pnpm workspace with an e2e package (`apps/shop/tests`) and a frontend one
 * (`apps/shop/ui`), for rules that gate on the package type they read from disk.
 *
 * @example
 * const workspace = createE2eWorkspace('my-rule-')
 * linter.verify(source, config, { filename: workspace.fileIn('cart.spec.ts') })
 * workspace.dispose()
 */
export const createE2eWorkspace = (prefix: string): E2eWorkspace => {
  const root = mkdtempSync(path.join(tmpdir(), prefix))

  const makePackage = (dir: string, type: string): void => {
    mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, dir, 'package.json'), `{ "name": "${type}" }\n`)
    writeFileSync(path.join(root, dir, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
  }

  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*/*'\n")
  writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')
  makePackage('apps/shop/tests', 'e2e')
  makePackage('apps/shop/ui', 'frontend')

  return {
    root,
    fileIn: (file, packageDir = 'apps/shop/tests') => {
      return path.join(root, packageDir, 'src/tests/checkout', file)
    },
    dispose: () => {
      rmSync(root, { recursive: true, force: true })
      resetPackageRootCache()
      resetPackageTypeCache()
    },
  }
}
