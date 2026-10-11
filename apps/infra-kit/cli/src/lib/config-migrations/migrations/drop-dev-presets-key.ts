import { dropTopLevelKey } from './drop-top-level-key'

export const dropDevPresetsKeyMigration = dropTopLevelKey({
  key: 'devServersPresets',
  id: 'drop-dev-presets-key',
  note: 'the unused "devServersPresets" key (run `infra-kit dev <app>` instead of a preset name)',
})
