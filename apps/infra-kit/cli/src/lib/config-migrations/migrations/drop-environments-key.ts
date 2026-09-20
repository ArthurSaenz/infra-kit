import { dropTopLevelKey } from './drop-top-level-key'

export const dropEnvironmentsKeyMigration = dropTopLevelKey({
  key: 'environments',
  id: 'drop-environments-key',
  note: 'the retired "environments" key (deploy targets now come from each workflow\'s workflow_dispatch options, auth from the token store)',
})
