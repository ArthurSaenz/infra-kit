import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// `boundaries/dependencies` RESOLVES each import's target on disk to classify it (feature/service/
// shared), so — unlike the string-only `no-restricted-imports` — its cases cannot run against a
// purely virtual path: the relative targets (`../alpha`, `../../shared`) must point at real files.
// We materialize a fixed scaffold tree (the "other end" of every boundaries import) into a temp dir
// once per suite; the per-case IMPORTER file is written inline at lint time (see boundaries.test.ts).
// This mirrors the infra-kit reference precedent require-component-stories.integration.test.ts, which
// uses mkdtempSync + afterAll cleanup for a real-fs suite.
//
// Only the import TARGETS live here. Element folders match the config's `**/features/*`, `**/services/*`,
// `**/shared` suffix globs even under an absolute /tmp prefix. `services/sms` is intentionally absent —
// no case imports an sms barrel (sms files are only importers).
const SCAFFOLD: Record<string, string> = {
  'src/features/alpha/index.ts':
    "export { thing } from './internal/thing'\nexport type { Thing } from './internal/thing'\n",
  'src/features/alpha/internal/thing.ts': "export const thing = 'thing'\nexport type Thing = { id: string }\n",
  'src/features/beta/local/util.ts': "export const util = 'util'\n",
  'src/services/email/index.ts':
    "export { client } from './internal/client'\nexport type { EmailClient } from './internal/client'\n",
  'src/services/email/internal/client.ts':
    "export const client = 'email-client'\nexport type EmailClient = { id: string }\n",
  'src/shared/index.ts': "export { sharedUtil } from './util'\nexport type { SharedThing } from './util'\n",
  'src/shared/util.ts': "export const sharedUtil = 'shared-util'\nexport type SharedThing = { id: string }\n",
}

export const makeTree = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wl-boundaries-'))

  for (const [rel, body] of Object.entries(SCAFFOLD)) {
    const abs = path.join(root, rel)

    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
