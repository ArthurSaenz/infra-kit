import { expect, test } from './__feature-kebab__.fixture'

/**
 * The one spec that demonstrates the full pattern end to end: create with a UNIQUE marker
 * (so the fixture cleans it up), find the row by that marker, and one validation example.
 *
 * As the feature grows, split this into the behavioral axes from references/conventions.md —
 * create-and-validation / edit / lifecycle / list-filter — rather than letting one file sprawl.
 */
test.describe('__Feature Title__ — crud', () => {
  test.beforeEach(async ({ __featureCamel__Page: page }) => {
    await page.goto()
  })

  test('creates an entity and shows it in the list', async ({ __featureCamel__Page: page }) => {
    const marker = page.nextMarker()

    await page.openAddDialog()
    await page.fillName(marker)
    await page.submit()

    await expect(page.rowByMarker(marker)).toBeVisible()
  })

  test('blocks submit when a required field is missing', async ({ __featureCamel__Page: page }) => {
    await page.openAddDialog()
    await page.submit()
    await expect(page.dialog).toBeVisible()
  })
})
