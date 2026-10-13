import { ESLint } from 'eslint'
import type { Linter } from 'eslint'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '../src/index.js'
import { code, only } from './_lint-case.js'

// `e2e/` declares @playwright/test; `app/` does not, so the rules must key off the package, not the path.
// realpath: macOS tmpdir is a symlink.
const SCAFFOLD: Record<string, string> = {
  'e2e/package.json': '{ "name": "e2e-fixture", "private": true, "devDependencies": { "@playwright/test": "*" } }\n',
  'app/package.json': '{ "name": "app-fixture", "private": true }\n',
}

let root: string
let eslint: ESLint

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wl-e2e-playwright-')))

  for (const [rel, body] of Object.entries(SCAFFOLD)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), body)
  }

  eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: await config() })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const ruleIds = async (relPath: string, source: string): Promise<(string | null)[]> => {
  const abs = path.join(root, relPath)

  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, source)

  const [result] = await eslint.lintText(source, { filePath: abs })
  const messages: Linter.LintMessage[] = result?.messages ?? []

  return only(messages, 'playwright/').map((m) => m.ruleId)
}

const SPEC = 'e2e/src/tests/alpha/home.spec.ts'

describe('e2e playwright rules: fire on e2e spec files', () => {
  it.each([
    [
      'playwright/missing-playwright-await',
      "test('a', async ({ page }) => { expect(page.locator('a')).toBeVisible() })",
    ],
    ['playwright/no-focused-test', "test.only('a', async ({ page }) => { await expect(page).toHaveURL('/') })"],
    [
      'playwright/no-wait-for-timeout',
      "test('a', async ({ page }) => { await page.waitForTimeout(500); await expect(page).toHaveURL('/') })",
    ],
    [
      'playwright/no-force-option',
      "test('a', async ({ page }) => { await page.locator('a').click({ force: true }); await expect(page).toHaveURL('/') })",
    ],
    [
      'playwright/no-conditional-expect',
      "test('a', async ({ page }) => { if (Math.random() > 0.5) { await expect(page).toHaveURL('/') } })",
    ],
    [
      'playwright/no-networkidle',
      "test('a', async ({ page }) => { await page.goto('/', { waitUntil: 'networkidle' }); await expect(page).toHaveURL('/') })",
    ],
    ['playwright/expect-expect', "test('a', async ({ page }) => { await page.goto('/') })"],
  ])('flags %s', async (ruleId, body) => {
    const source = `import { expect, test } from '@playwright/test'\n\n${body}\n`

    expect(await ruleIds(SPEC, source)).toContain(ruleId)
  })

  it('accepts page-object assertion helpers as assertions', async () => {
    const source = code`
      import { test } from '@playwright/test'

      test('a', async ({ page }) => {
        await expectOk(page)
        await page.goto('/')
        await homePage.assertVisible()
      })

      test('b', async ({ page }) => {
        await homePage.expectLoaded(page)
      })
    `

    expect(await ruleIds(SPEC, source)).toEqual([])
  })
})

describe('e2e playwright rules: expect-expect exemptions', () => {
  it('ignores fixme and skip placeholders but still flags a plain test', async () => {
    const source = code`
      import { test } from '@playwright/test'

      test.fixme('pending a', async () => {})
      test.skip('pending b', async () => {})
      test('hollow', async ({ page }) => {
        await page.goto('/')
      })
    `

    expect(await ruleIds(SPEC, source)).toEqual(['playwright/expect-expect'])
  })
})

describe('e2e playwright rules: scoped to Playwright packages', () => {
  it('does not apply to a non-e2e package', async () => {
    const source =
      "import { test } from '@playwright/test'\n\ntest.only('a', async ({ page }) => { await page.goto('/') })\n"

    expect(await ruleIds('app/src/features/a/home.spec.ts', source)).toEqual([])
  })
})
