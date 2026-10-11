import { dropTopLevelKey } from './drop-top-level-key'

export const dropIdeKeyMigration = dropTopLevelKey({
  key: 'ide',
  id: 'drop-ide-key',
  note: 'the unused "ide" key (worktrees add/remove no longer edit a Cursor .code-workspace)',
})
