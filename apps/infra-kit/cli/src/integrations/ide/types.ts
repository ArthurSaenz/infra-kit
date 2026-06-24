export type IdeProvider = 'cursor' | 'zed'

/**
 * CLI-level open modes for `worktrees-add` (`--ide`). `workspace` adds each
 * created worktree to the configured editor's workspace and opens it (the only
 * attach style); `none` means "don't open any editor".
 */
export const IDE_MODES = ['workspace', 'none'] as const
export type IdeMode = (typeof IDE_MODES)[number]

// Each facade returns one outcome PER configured provider (an array), so every
// outcome is tagged with its `provider`.
export interface OpenIdeWorkspaceOutcome {
  ran: boolean
  provider: IdeProvider
  added: number
  removed: number
}

export interface AddIdeWorktreeFoldersOutcome {
  ran: boolean
  provider: IdeProvider
  added: number
  skipped: number
}

export interface RemoveIdeWorktreeFoldersOutcome {
  provider: IdeProvider
  /**
   * True when the provider can reflect a removal. Both providers now report
   * `true`; `false` is reserved for a future provider with no remove capability.
   */
  supported: boolean
  /**
   * Folders confirmed removed. For Cursor this is the real diff of the
   * `.code-workspace` `folders` array. For Zed it is ALWAYS `[]`: the only
   * mechanism (`zed --reuse`) replaces the whole window without producing a
   * diff, so it confirms no specific removal even when it refreshed the window.
   */
  removed: string[]
}
