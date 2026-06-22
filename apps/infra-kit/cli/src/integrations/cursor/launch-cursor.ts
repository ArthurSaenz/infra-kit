import { $ } from 'zx'

/**
 * Spawns Cursor against a `.code-workspace` file (or any path). Centralised here
 * — rather than inlined at each call site — so the editor spawn lives inside the
 * cursor provider module and is covered by a single `vi.mock('src/integrations/cursor')`.
 * Keeping it out of the IDE-orchestration layer is what stops tests that mock the
 * provider (but not `zx`) from shelling out to a real editor.
 */
export const launchCursor = async (workspacePath: string): Promise<void> => {
  await $`cursor ${workspacePath}`
}
