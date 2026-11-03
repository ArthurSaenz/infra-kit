import tsParser from '@typescript-eslint/parser'
import { Linter, RuleTester } from 'eslint'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPackageRootCache } from '../../../utils/package-root'
import { resetPackageTypeCache } from '../../../utils/package-type-reader'
import { featureFiles } from '../feature-files'

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

// Virtual filenames have no package on disk, so they count as frontend and have no sibling folders.
const FEATURE = '/repo/src/features/search'
const CODE = 'export const a = 1'
const JSX = 'export const render = () => <div><span /></div>'
const ROOT_ALLOWED = 'index.ts, types.ts, services.ts, analytics.ts, constants.ts, translates.ts'

ruleTester.run('feature-files', featureFiles, {
  valid: [
    ...['index.ts', 'types.ts', 'services.ts', 'analytics.ts', 'constants.ts', 'translates.ts', 'index.tsx'].map(
      (file) => {
        return { code: CODE, filename: `${FEATURE}/${file}` }
      },
    ),
    ...['main.ts', 'api.ts', 'libs.ts', 'index.ts', 'types.ts', 'constants.ts'].map((file) => {
      return { code: CODE, filename: `${FEATURE}/services/${file}` }
    }),
    // Below `services/` names are not judged; other segments are package-structure's concern.
    { code: CODE, filename: `${FEATURE}/services/search/anything.ts` },
    { code: JSX, filename: `${FEATURE}/containers/search-container.tsx` },
    { code: JSX, filename: `${FEATURE}/components/search-bar.tsx` },
    // Outside a feature root.
    { code: CODE, filename: '/repo/src/lib/helpers.ts' },
    { code: CODE, filename: '/repo/src/features/helpers.ts' },
    { code: CODE, filename: '/repo/lib/features/search/helpers.ts' },
    // Tests, stories and declarations are exempt.
    { code: JSX, filename: `${FEATURE}/__tests__/services.test.tsx` },
    { code: CODE, filename: `${FEATURE}/helpers.test.ts` },
    { code: JSX, filename: `${FEATURE}/__stories__/search.stories.tsx` },
    { code: JSX, filename: `${FEATURE}/services/__tests__/main.test.tsx` },
    { code: 'declare const x: number', filename: `${FEATURE}/globals.d.ts` },
    // Options.
    { code: CODE, filename: `${FEATURE}/routes.ts`, options: [{ extraRootFiles: ['routes'] }] },
    { code: CODE, filename: `${FEATURE}/services/mocks.ts`, options: [{ extraServiceFiles: ['mocks'] }] },
    { code: CODE, filename: `${FEATURE}/helpers.ts`, options: [{ ignore: ['**/features/search/**'] }] },
    { code: CODE, filename: `${FEATURE}/helpers.ts`, options: [{ paths: ['**/features/other/**'] }] },
  ],

  invalid: [
    {
      code: CODE,
      filename: `${FEATURE}/service.ts`,
      errors: [{ message: `"service.ts" is not an allowed feature-root file. Allowed: ${ROOT_ALLOWED}.` }],
    },
    {
      code: CODE,
      filename: `${FEATURE}/helpers.tsx`,
      errors: [{ messageId: 'unknownRootFile', line: 1, column: 1 }],
    },
    {
      code: CODE,
      filename: `${FEATURE}/services/helpers.ts`,
      errors: [
        {
          message:
            '"helpers.ts" is not an allowed file in `services/`. Allowed: main.ts, api.ts, libs.ts, index.ts, types.ts, constants.ts.',
        },
      ],
    },
    {
      code: CODE,
      filename: `${FEATURE}/routes.ts`,
      options: [{ extraRootFiles: ['config'] }],
      errors: [{ message: `"routes.ts" is not an allowed feature-root file. Allowed: ${ROOT_ALLOWED}, config.ts.` }],
    },
    {
      code: CODE,
      filename: `${FEATURE}/helpers.ts`,
      options: [{ paths: ['**/features/search/**'] }],
      errors: [{ messageId: 'unknownRootFile' }],
    },
    // JSX in a service file is reported once, on the first element.
    {
      code: JSX,
      filename: `${FEATURE}/services/main.tsx`,
      errors: [
        {
          message: 'Services hold atoms and pure functions; JSX belongs in a component or container.',
          line: 1,
          column: 29,
        },
      ],
    },
    {
      code: 'export const f = () => <></>',
      filename: `${FEATURE}/services.tsx`,
      errors: [{ messageId: 'jsxInService' }],
    },
    { code: JSX, filename: `${FEATURE}/services/search/view.tsx`, errors: [{ messageId: 'jsxInService' }] },
    // A wrong name and JSX are both reported.
    {
      code: JSX,
      filename: `${FEATURE}/services/view.tsx`,
      errors: [{ messageId: 'unknownServiceFile' }, { messageId: 'jsxInService' }],
    },
  ],
})

// `services.ts` vs `services/` and the package-type gate both need a real tree on disk.
describe('feature-files on disk', () => {
  let root: string
  let linter: Linter

  const lint = (relFile: string, packageDir = 'apps/frontend'): string[] => {
    const config: Linter.Config = {
      files: ['**/*.ts'],
      plugins: { '@wl': { rules: { 'feature-files': featureFiles } } },
      languageOptions: { parser: tsParser },
      rules: { '@wl/feature-files': 'error' },
    }

    return linter.verify(CODE, config, { filename: path.join(root, packageDir, 'src', relFile) }).map((message) => {
      return message.message
    })
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'feature-files-'))
    linter = new Linter({ cwd: root })

    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
    writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "private": true }\n')

    for (const type of ['frontend', 'backend', 'e2e']) {
      mkdirSync(path.join(root, 'apps', type), { recursive: true })
      writeFileSync(path.join(root, 'apps', type, 'package.json'), `{ "name": "${type}" }\n`)
      writeFileSync(path.join(root, 'apps', type, 'infra-kit.config.ts'), `export default { type: '${type}' }\n`)
    }

    mkdirSync(path.join(root, 'apps/frontend/src/features/both/services'), { recursive: true })
    mkdirSync(path.join(root, 'apps/frontend/src/features/single'), { recursive: true })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    resetPackageRootCache()
    resetPackageTypeCache()
  })

  it('reports services.ts next to a services/ folder', () => {
    expect(lint('features/both/services.ts')).toEqual([
      'Feature "both" has both `services.ts` and a `services/` folder. Keep one: move this file into `services/main.ts`, or fold the folder into this file.',
    ])
  })

  it('accepts services.ts alone', () => {
    expect(lint('features/single/services.ts')).toEqual([])
  })

  it('reports in a frontend package', () => {
    expect(lint('features/single/helpers.ts')).toHaveLength(1)
  })

  it('skips backend and e2e packages', () => {
    expect(lint('features/single/helpers.ts', 'apps/backend')).toEqual([])
    expect(lint('features/single/helpers.ts', 'apps/e2e')).toEqual([])
  })
})
