export interface PaletteItem {
  /** Command name (the token passed to the CLI, e.g. `release-list`). */
  name: string
  /** One-line description (sourced from Commander). */
  description: string
  /** Display group header (e.g. "Release Management"). */
  group: string
}
