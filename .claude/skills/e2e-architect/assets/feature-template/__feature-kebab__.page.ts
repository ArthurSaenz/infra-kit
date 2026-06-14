import { E2E_BASE_URL_BACKOFFICE } from '#root/constants'
import type { Locator, Page } from '@playwright/test'

/**
 * Page Object for the __Feature Title__ feature.
 *
 * This is the ONLY place selectors for this feature live. Specs call action methods
 * (`fill…`, `select…`, `open…`) and read `get…` getters — they never call `page.getByRole(...)`
 * directly, so a UI change touches one file.
 *
 * This template is intentionally MINIMAL. Add locators/methods as the feature needs them, and
 * grow the spec set along the behavioral axes documented in references/conventions.md
 * (smoke → create+validation → edit → lifecycle → list-filter).
 *
 * `createdMarkers` records a unique marker for every entity the test creates so the fixture
 * can clean them up in teardown — keep this even in the smallest suite.
 */
export class __FeaturePascal__Page {
  private static uniqueCounter = 0

  readonly createdMarkers: string[] = []
  readonly page: Page
  readonly pageHeading: Locator
  readonly addButton: Locator
  readonly table: Locator
  readonly dialog: Locator

  constructor(page: Page) {
    this.page = page
    this.pageHeading = page.getByRole('heading', { name: /__Feature Title__/i })
    this.addButton = page.getByRole('button', { name: /add/i })
    this.table = page.getByRole('table')
    this.dialog = page.getByRole('dialog')
  }

  /**
   * A unique, human-readable marker so created rows are findable AND cleanable.
   * The counter is per-process, so in parallel runs pass a worker-unique prefix
   * (e.g. `nextMarker(\`w${testInfo.workerIndex}\`)`) to avoid cross-worker collisions.
   */
  nextMarker(prefix = 'e2e'): string {
    __FeaturePascal__Page.uniqueCounter += 1
    const marker = `${prefix}-__feature-kebab__-${__FeaturePascal__Page.uniqueCounter}`
    this.createdMarkers.push(marker)
    return marker
  }

  async goto() {
    await this.page.goto(`${E2E_BASE_URL_BACKOFFICE}/__feature-kebab__`)
    await this.pageHeading.waitFor()
  }

  rowByMarker(marker: string): Locator {
    return this.table.getByRole('row').filter({ hasText: marker })
  }

  async openAddDialog() {
    await this.addButton.click()
    await this.dialog.waitFor()
  }

  /**
   * Fill a dialog field by its visible label. Prefer named `fill…` methods (see `fillName`)
   * so specs never pass raw label strings; use this generic helper only while prototyping.
   */
  async fillField(label: string, value: string) {
    await this.dialog.getByLabel(label).fill(value)
  }

  /** Named field method — the convention specs should use. Add one per field. */
  async fillName(value: string) {
    await this.fillField('Name', value)
  }

  async submit() {
    await this.dialog.getByRole('button', { name: /save|create|submit/i }).click()
  }
}
