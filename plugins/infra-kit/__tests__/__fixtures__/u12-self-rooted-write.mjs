// Red fixture for PM-2: a script that caches state beside itself. ${CLAUDE_PLUGIN_ROOT} moves on
// every plugin update and the previous directory is deleted, so this write is lost silently.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CACHE = path.join(HERE, 'cache.json')

fs.writeFileSync(CACHE, JSON.stringify({ lastRun: Date.now() }))
