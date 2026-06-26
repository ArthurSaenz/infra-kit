import { DetectorGroup } from '#root/groups'
import { Severity } from '#root/severity'
import type { Detector } from '#root/types'

export const changePatternsDetectors: Detector[] = [
  {
    id: 'shotgun-surgery',
    group: DetectorGroup.changePatterns,
    scope: 'graph',
    title: 'Shotgun surgery (single change requires edits across many modules)',
    description:
      'A single conceptual change — such as adding a new variant, a new event type, or a new operation — forces edits scattered across many unrelated modules.',
    rationale:
      'Shotgun surgery is the inverse of a cohesion problem: the concept is fragmented across the codebase instead of being housed in one place. Every new variant requires the developer to hunt down every switch statement, every type union, every if-else chain that mentions the concept. Detection requires git change-history analysis to identify which files co-change on the same commits; the examples below illustrate the structural shape of the smell without needing history.',
    defaultSeverity: Severity.info,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Switch-based dispatch scattered across modules',
        bad: `// router.ts
const route = (action: string) => {
  switch (action) {
    case 'create': return handleCreate()
    case 'delete': return handleDelete()
  }
}

// logger.ts
const logAction = (action: string) => {
  switch (action) {
    case 'create': console.log('creating')
    case 'delete': console.log('deleting')
  }
}

// metrics.ts
const trackAction = (action: string) => {
  switch (action) {
    case 'create': increment('create')
    case 'delete': increment('delete')
  }
}`,
        good: `// actions.ts
type ActionHandler = {
  route: () => void
  log: () => void
  track: () => void
}

const registry: Record<string, ActionHandler> = {
  create: {
    route: handleCreate,
    log: () => console.log('creating'),
    track: () => increment('create'),
  },
  delete: {
    route: handleDelete,
    log: () => console.log('deleting'),
    track: () => increment('delete'),
  },
}

const dispatch = (action: string) => {
  const handler = registry[action]
  if (!handler) return
  handler.route()
  handler.log()
  handler.track()
}`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'unstable-interface',
    group: DetectorGroup.changePatterns,
    scope: 'project',
    title: 'Unstable public interface (frequently changed contract breaks consumers)',
    description:
      'A public interface, type, or API surface changes frequently, requiring updates in every consumer on each revision.',
    rationale:
      'A public interface is a contract; every breaking change multiplies the cost by the number of consumers. Frequent changes signal that the interface absorbed implementation detail that should have stayed private, or that the abstraction level is wrong. Detection uses git history to measure interface churn and fan-out impact; the examples below show the structural difference between a leaky interface and a stable narrow contract.',
    defaultSeverity: Severity.info,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Leaky interface exposes internals vs stable narrow contract',
        bad: `// user-service.ts — public interface leaks storage detail
export interface UserService {
  findByDbRow(row: DbRow): User
  saveWithTransaction(tx: Transaction, user: User): void
  cacheKey(userId: string): string
}

// consumer-a.ts
import type { UserService } from './user-service'
const save = (svc: UserService, tx: Transaction, u: User) =>
  svc.saveWithTransaction(tx, u)

// consumer-b.ts
import type { UserService } from './user-service'
const key = (svc: UserService, id: string) => svc.cacheKey(id)`,
        good: `// user-service.ts — narrow stable contract
export interface UserService {
  getUser(id: string): Promise<User>
  saveUser(user: User): Promise<void>
}

// consumer-a.ts
import type { UserService } from './user-service'
const save = (svc: UserService, u: User) => svc.saveUser(u)

// consumer-b.ts
import type { UserService } from './user-service'
const get = (svc: UserService, id: string) => svc.getUser(id)`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
]
