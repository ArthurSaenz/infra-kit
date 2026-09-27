import { expect, test } from './fixtures/__feature-kebab__.fixture'

/**
 * The page loads and its core controls are present. No data is created here, so it is tagged
 * `@smoke` (the fast post-deploy signal) and `@readonly` (safe against any shared environment).
 */
test.describe('__Feature Title__', { tag: ['@smoke', '@readonly'] }, () => {
  test.beforeEach(async ({ __featureCamel__Page: page }) => {
    await page.goto()
  })

  test('shows the page header and Add button', async ({ __featureCamel__Page: page }) => {
    await expect(page.pageHeading).toBeVisible()
    await expect(page.addButton).toBeVisible()
  })

  test('opens the Add dialog', async ({ __featureCamel__Page: page }) => {
    await page.openAddDialog()
    await expect(page.dialog).toBeVisible()
  })
})
