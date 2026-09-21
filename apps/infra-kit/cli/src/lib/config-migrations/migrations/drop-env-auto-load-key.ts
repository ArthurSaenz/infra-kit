import { dropTopLevelKey } from './drop-top-level-key'

export const dropEnvAutoLoadKeyMigration = dropTopLevelKey({
  key: 'envAutoLoad',
  id: 'drop-env-auto-load-key',
  note: 'the retired "envAutoLoad" key (env auto-load is gone — run `env-load -c <config>` in the terminal)',
})
