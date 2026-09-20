import { dropTopLevelKey } from './drop-top-level-key'

export const dropDevProxyKeyMigration = dropTopLevelKey({
  key: 'devProxy',
  id: 'drop-dev-proxy-key',
  note: 'the retired "devProxy" key (dev URLs are port-free https://<release>.<package>.localhost)',
})
