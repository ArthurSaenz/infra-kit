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
  /** False when the configured provider has no folder-remove capability (Zed). */
  supported: boolean
  removed: string[]
}
