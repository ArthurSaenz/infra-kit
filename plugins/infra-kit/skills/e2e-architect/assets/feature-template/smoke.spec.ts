import { expect, test } from './__feature-kebab__.fixture'

/**
 * Smoke: the page loads and its core controls are present. No data is created here.
 * Keep these fast and dependency-free — they are the first signal that the feature renders.
 */
test.describe('__Feature Title__ — smoke', () => {
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
