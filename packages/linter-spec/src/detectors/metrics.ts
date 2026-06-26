import { DetectorGroup } from '#root/groups'
import { Severity } from '#root/severity'
import type { Detector } from '#root/types'

export const metricsDetectors: Detector[] = [
  {
    id: 'abstractness',
    group: DetectorGroup.metrics,
    scope: 'graph',
    title: 'Abstractness / instability imbalance (Martin metrics)',
    description:
      'A module sits in the "zone of pain" (highly concrete + heavily depended-on) or the "zone of uselessness" (highly abstract + no dependents), violating the ideal A+I≈1 balance from Robert Martin\'s package metrics.',
    rationale:
      'Martin\'s Abstractness (A) and Instability (I) metrics define a "main sequence" where A+I≈1. Modules in the zone of pain are concrete yet load-bearing — any change ripples everywhere. Modules in the zone of uselessness are abstract but never used — dead weight that confuses readers and AI tools. Keeping modules on or near the main sequence lets stable modules be abstract (swappable) and concrete modules be volatile (free to change).',
    defaultSeverity: Severity.info,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Zone of pain: concrete class imported by everything',
        bad: `// db/connection.ts  (0 abstract members, depended on by 30 modules)
export class DbConnection {
  connect() { /* ... */ }
  query(sql: string) { /* ... */ }
}`,
        good: `// db/connection.ts
export interface DbConnection {
  connect(): void
  query(sql: string): Promise<unknown[]>
}

// db/pg-connection.ts  (concrete impl, only infrastructure imports this)
import type { DbConnection } from './connection'
export class PgConnection implements DbConnection {
  connect() { /* ... */ }
  query(sql: string) { return Promise.resolve([]) }
}`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'scattered-config',
    group: DetectorGroup.metrics,
    scope: 'project',
    title: 'Configuration scattered across multiple files',
    description:
      'The same configuration value (API URL, timeout, feature flag, environment key) is defined or hard-coded in more than a configurable number of source files instead of being read from a single authoritative source.',
    rationale:
      'Scattered configuration means changing one value requires hunting across the codebase. It introduces inconsistency (different files may drift), makes environment-specific overrides fragile, and forces AI assistants to scan the whole project to understand what is configurable. A single config source makes the contract explicit, testable, and easy to override per environment.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'API base URL duplicated in three files',
        bad: `// services/user-service.ts
const BASE = 'https://api.example.com'

// services/order-service.ts
const BASE = 'https://api.example.com'

// utils/http.ts
const ROOT = 'https://api.example.com'`,
        good: `// config/index.ts
export const config = {
  apiBase: process.env['API_BASE'] ?? 'https://api.example.com',
}

// services/user-service.ts
import { config } from '../config'
const base = config.apiBase

// services/order-service.ts
import { config } from '../config'
const base = config.apiBase`,
      },
    ],
    options: [
      {
        name: 'maxConfigSites',
        type: 'number',
        default: 3,
        description:
          'Maximum number of files in which the same configuration literal may appear before the detector fires.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'code-clone',
    group: DetectorGroup.metrics,
    scope: 'graph',
    title: 'Duplicated or near-duplicate code blocks across the project',
    description:
      'Substantially identical code blocks appear in two or more files, indicating that shared logic has been copy-pasted rather than extracted into a reusable module.',
    rationale:
      'Code clones multiply the cost of every bug fix and behaviour change — each copy must be updated separately, and they inevitably drift. They inflate the knowledge surface an AI assistant must hold in context to reason about invariants. Extracting shared logic to a named helper makes the intent explicit, reduces total code size, and gives refactoring tools a single point of change.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Identical validation logic copy-pasted across two files',
        bad: `// handlers/create-user.ts
function isValidEmail(email: string) {
  return email.includes('@') && email.length > 3
}

// handlers/update-user.ts
function isValidEmail(email: string) {
  return email.includes('@') && email.length > 3
}`,
        good: `// utils/validate.ts
export function isValidEmail(email: string) {
  return email.includes('@') && email.length > 3
}

// handlers/create-user.ts
import { isValidEmail } from '../utils/validate'

// handlers/update-user.ts
import { isValidEmail } from '../utils/validate'`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: {
      status: 'partial',
      plugin: 'sonarjs',
      rule: 'sonarjs/no-identical-functions',
      note: 'sonarjs catches identical functions per-file; whole-graph near-duplicate detection is the gap.',
    },
  },
]
