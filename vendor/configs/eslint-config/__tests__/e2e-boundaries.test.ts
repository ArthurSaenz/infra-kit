import { ESLint } from 'eslint'
import type { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '../src/index.js'
import { code, only } from './_lint-case.js'

// Import targets of every case, written once. `e2e/` is a Playwright package; `app/` has the same
// folder names without `@playwright/test`, so it proves the layer keys off the package, not the path.
// realpath for the same reason as _boundaries-tree.ts: macOS tmpdir is a symlink.
const SCAFFOLD: Record<string, string> = {
  'e2e/package.json': '{ "name": "e2e-fixture", "private": true, "devDependencies": { "@playwright/test": "*" } }\n',
  'e2e/src/config/environment.ts': "export const environment = 'dev'\n",
  'e2e/src/lib/url.ts': "export const url = 'url'\n",
  'e2e/src/mocks/order.mock.ts': "export const orderMock = 'order'\n",
  'e2e/src/components/header.component.ts': "export const header = 'header'\n",
  'e2e/src/pages/home.page.ts': "export const homePage = 'home'\n",
  'e2e/src/fixtures/base.fixture.ts': "export const test = 'test'\n",
  'e2e/src/tests/alpha/fixtures/alpha.fixture.ts': "export const alpha = 'alpha'\n",
  'app/package.json': '{ "name": "app-fixture", "private": true }\n',
  'app/src/pages/home.ts': "export const home = 'home'\n",
}

let root: string
let eslint: ESLint

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wl-e2e-boundaries-')))

  for (const [rel, body] of Object.entries(SCAFFOLD)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), body)
  }

  eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: await config() })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const lintAt = async (relPath: string, source: string): Promise<Linter.LintMessage[]> => {
  const abs = path.join(root, relPath)

  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, source)

  const [result] = await eslint.lintText(source, { filePath: abs })

  return only(result?.messages ?? [], 'boundaries/')
}

const expectFlagged = (messages: Linter.LintMessage[], ruleId = 'boundaries/dependencies') => {
  expect(messages.map((m) => m.ruleId)).toEqual([ruleId])
}

const expectClean = (messages: Linter.LintMessage[]) => {
  expect(messages).toEqual([])
}

describe('e2e boundaries: shared layers import downward only', () => {
  it('flags lib importing pages', async () => {
    expectFlagged(
      await lintAt(
        'e2e/src/lib/wait.ts',
        code`
      import { homePage } from '../pages/home.page'
      export const wait = homePage
    `,
      ),
    )
  })

  it('flags pages importing fixtures', async () => {
    expectFlagged(
      await lintAt(
        'e2e/src/pages/cart.page.ts',
        code`
      import { test } from '../fixtures/base.fixture'
      export const cart = test
    `,
      ),
    )
  })

  it('allows fixtures importing pages, components, mocks, lib and config', async () => {
    expectClean(
      await lintAt(
        'e2e/src/fixtures/cart.fixture.ts',
        code`
      import { header } from '../components/header.component'
      import { environment } from '../config/environment'
      import { url } from '../lib/url'
      import { orderMock } from '../mocks/order.mock'
      import { homePage } from '../pages/home.page'
      export const cart = [header, environment, url, orderMock, homePage]
    `,
      ),
    )
  })

  it('resolves #root/* imports, so an aliased upward import is caught too', async () => {
    expectFlagged(
      await lintAt(
        'e2e/src/mocks/cart.mock.ts',
        code`
      import { homePage } from '#root/pages/home.page'
      export const cartMock = homePage
    `,
      ),
    )
  })
})

describe('e2e boundaries: domain folders are private', () => {
  it('allows a domain importing its own files and every shared layer', async () => {
    expectClean(
      await lintAt(
        'e2e/src/tests/alpha/checkout.spec.ts',
        code`
      import { alpha } from './fixtures/alpha.fixture'
      import { test } from '../../fixtures/base.fixture'
      import { homePage } from '../../pages/home.page'
      export const spec = [alpha, test, homePage]
    `,
      ),
    )
  })

  it('flags a domain reaching into a sibling domain', async () => {
    expectFlagged(
      await lintAt(
        'e2e/src/tests/beta/checkout.spec.ts',
        code`
      import { alpha } from '../alpha/fixtures/alpha.fixture'
      export const spec = alpha
    `,
      ),
    )
  })

  it('flags a shared layer importing a domain', async () => {
    expectFlagged(
      await lintAt(
        'e2e/src/lib/leak.ts',
        code`
      import { alpha } from '../tests/alpha/fixtures/alpha.fixture'
      export const leak = alpha
    `,
      ),
    )
  })

  it('allows setup importing shared layers', async () => {
    expectClean(
      await lintAt(
        'e2e/src/setup/auth.setup.ts',
        code`
      import { test } from '../fixtures/base.fixture'
      export const setup = test
    `,
      ),
    )
  })
})

describe('e2e boundaries: scope', () => {
  it('flags a file at the src root, which belongs in config/', async () => {
    expectFlagged(
      await lintAt('e2e/src/constants.ts', "export const BASE_URL = 'https://example.test'\n"),
      'boundaries/no-unknown-files',
    )
  })

  it('flags a file outside every layer', async () => {
    expectFlagged(
      await lintAt('e2e/src/utils/helper.ts', "export const helper = 'helper'\n"),
      'boundaries/no-unknown-files',
    )
  })

  it('leaves a non-Playwright package with the same folder names alone', async () => {
    expectClean(
      await lintAt(
        'app/src/lib/uses-page.ts',
        code`
      import { home } from '../pages/home'
      export const usesPage = home
    `,
      ),
    )
  })
})
