import tsParser from '@typescript-eslint/parser'
import { Linter, RuleTester } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import { noHooksInServices } from '../no-hooks-in-services'

// Wire ESLint's RuleTester into vitest's lifecycle so each case becomes a real test.
const ruleTesterHooks = RuleTester as unknown as {
  afterAll: typeof afterAll
  describe: typeof describe
  it: typeof it
  itOnly: typeof it.only
}

ruleTesterHooks.afterAll = afterAll
ruleTesterHooks.describe = describe
ruleTesterHooks.it = it
// eslint-disable-next-line test/no-only-tests -- RuleTester requires an `itOnly` hook reference.
ruleTesterHooks.itOnly = it.only

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaFeatures: { jsx: true }, ecmaVersion: 'latest', sourceType: 'module' },
  },
})

// Virtual filenames have no package on disk, so they count as frontend.
const FEATURE = '/repo/src/features/search'
const HOOK = 'export const useSearch = () => useAtomValue($search)'

const HOOK_ERROR = {
  message:
    '"useSearch" is a hook, and services hold only atoms and pure functions. Move it to a container or to `lib/`.',
}

ruleTester.run('no-hooks-in-services', noHooksInServices, {
  valid: [
    // Atoms and pure functions are what services hold.
    {
      code: 'export const $query = atom("")\nexport const toQuery = (s: string) => s.trim()',
      filename: `${FEATURE}/services/main.ts`,
    },
    // Calling a hook-shaped function is not a declaration (it would sit inside a declared hook anyway).
    { code: 'export const run = () => useSomething()', filename: `${FEATURE}/services/main.ts` },
    // `user` is not `use` + capital.
    { code: 'export const userName = () => "x"', filename: `${FEATURE}/services/main.ts` },
    // A hook outside services is fine.
    { code: HOOK, filename: `${FEATURE}/containers/search.tsx` },
    { code: HOOK, filename: '/repo/src/lib/use-services.ts' },
    { code: HOOK, filename: '/repo/src/entities/user/hooks.ts' },
    // Tests and stories are exempt.
    { code: HOOK, filename: `${FEATURE}/services/__tests__/main.test.ts` },
    { code: HOOK, filename: `${FEATURE}/services/main.test.ts` },
    // ignore wins; paths replaces the defaults.
    { code: HOOK, filename: `${FEATURE}/services/main.ts`, options: [{ ignore: ['**/features/search/**'] }] },
    { code: HOOK, filename: `${FEATURE}/services/main.ts`, options: [{ paths: ['**/model.ts'] }] },
  ],

  invalid: [
    { code: HOOK, filename: `${FEATURE}/services/main.ts`, errors: [HOOK_ERROR] },
    { code: HOOK, filename: `${FEATURE}/services/nested/libs.ts`, errors: [HOOK_ERROR] },
    { code: HOOK, filename: `${FEATURE}/services.ts`, errors: [HOOK_ERROR] },
    { code: HOOK, filename: `${FEATURE}/services.tsx`, errors: [HOOK_ERROR] },
    { code: HOOK, filename: `${FEATURE}/service.ts`, errors: [HOOK_ERROR] },
    { code: HOOK, filename: '/repo/src/entities/user/model.ts', errors: [HOOK_ERROR] },
    { code: HOOK, filename: '/repo/src/entities/user/session/model.tsx', errors: [HOOK_ERROR] },
    // Function declaration and function expression forms, at any depth.
    {
      code: 'export function useSearch() {}\nconst x = { y: () => { const useInner = function () {} } }',
      filename: `${FEATURE}/services/main.ts`,
      errors: [
        { messageId: 'hookInService', line: 1 },
        { messageId: 'hookInService', line: 2 },
      ],
    },
    {
      code: HOOK,
      filename: '/repo/src/state/search.ts',
      options: [{ paths: ['**/state/**'] }],
      errors: [HOOK_ERROR],
    },
  ],
})

// The package type is read from disk, so the gate needs a real workspace.
describe('no-hooks-in-services package-type gate', () => {
  let root: string
  let linter: Linter

  const lint = (packageDir: string): number => {
    const config: Linter.Config = {
      files: ['**/*.ts'],
      plugins: { '@wl': { rules: { 'no-hooks-in-services': noHooksInServices } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/no-hooks-in-services': 'error' },
    }

    return linter.verify(HOOK, config, { filename: path.join(root, packageDir, 'src/services/search.ts') }).length
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'no-hooks-in-services-'))
    linter = new Linter({ cwd: root })

    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
    writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')

    for (const type of ['frontend', 'backend', 'e2e']) {
      mkdirSync(path.join(root, 'apps', type), { recursive: true })
      writeFileSync(path.join(root, 'apps', type, 'package.json'), `{ "name": "${type}" }\n`)
      writeFileSync(path.join(root, 'apps', type, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
    }
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    resetPackageRootCache()
    resetPackageTypeCache()
  })

  it('reports in a frontend package', () => {
    expect(lint('apps/frontend')).toBe(1)
  })

  it('skips backend and e2e packages', () => {
    expect(lint('apps/backend')).toBe(0)
    expect(lint('apps/e2e')).toBe(0)
  })
})
