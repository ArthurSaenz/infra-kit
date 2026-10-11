import { dropTopLevelKey } from './drop-top-level-key'

export const dropTaskManagerKeyMigration = dropTopLevelKey({
  key: 'taskManager',
  id: 'drop-task-manager-key',
  note: 'the unused "taskManager" key (Jira is configured by the JIRA_BASE_URL / JIRA_PROJECT_ID env vars in Doppler)',
})
