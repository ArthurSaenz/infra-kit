import { dropTopLevelKey } from './drop-top-level-key'

export const dropDevKeyMigration = dropTopLevelKey({
  key: 'dev',
  id: 'drop-dev-key',
  note: 'the unused "dev" key (a dev server port comes from <APP>_PORT / PORT, else the built-in default)',
})
