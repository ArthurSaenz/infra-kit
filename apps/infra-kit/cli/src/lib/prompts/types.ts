/**
 * Item shape consumed by the Ink branch pickers.
 *
 * Owned by `src/lib/prompts` rather than `src/tui` on purpose: commands and the
 * `release-picker` shim must never reference `src/tui`, even for a type, or the
 * no-React boundary (eslint `noTuiOnMachinePaths` + `no-react-boundary.test.ts`)
 * would be crossed. The TUI screens import this type-only from here instead.
 *
 * This file must keep ZERO imports so it can be type-imported from any layer
 * without creating a cycle.
 */
export interface BranchPickerItem {
  /** The value returned on selection (a branch name, or the `dev` sentinel). */
  value: string
  /** Primary display text (the release label). */
  label: string
  /** Dimmed secondary text (Jira description); filtered on alongside `label`. */
  description?: string
  /** Release type, used for colouring. Kept a plain string to avoid coupling to release-utils. */
  type?: string
}
