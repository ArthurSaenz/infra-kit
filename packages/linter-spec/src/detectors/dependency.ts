import { DetectorGroup } from '#root/groups'
import { Severity } from '#root/severity'
import type { Detector } from '#root/types'

export const dependencyDetectors: Detector[] = [
  {
    id: 'cyclic-dependency',
    group: DetectorGroup.dependency,
    scope: 'graph',
    title: 'Cyclic dependency between modules',
    description: 'Two modules import each other directly, creating a cycle (A → B → A).',
    rationale:
      'Cycles prevent modules from being understood or tested in isolation. They inflate build graphs, cause initialization-order bugs, and make incremental compilation slower. AI-assisted refactors are error-prone in cyclic graphs because a change in one node ripples back to its own dependents unexpectedly.',
    defaultSeverity: Severity.error,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Direct A↔B cycle',
        bad: `// a.ts
import { b } from './b'
export const a = () => b()

// b.ts
import { a } from './a'
export const b = () => a()`,
        good: `// shared.ts
export const shared = () => 'base'

// a.ts
import { shared } from './shared'
export const a = () => shared()

// b.ts
import { shared } from './shared'
export const b = () => shared()`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'cycle-clusters',
    group: DetectorGroup.dependency,
    scope: 'graph',
    title: 'Cycle cluster (3+ mutually-importing modules)',
    description:
      'Three or more modules form a tightly coupled cluster where each imports from at least one other in the group, making the whole cluster a single logical unit with no clean boundaries.',
    rationale:
      'Clusters compound the harms of pairwise cycles: they block tree-shaking, make ownership unclear, and create blast radii where a single change forces re-compilation of every node in the cluster. LLMs navigating such clusters cannot reason about module responsibility without loading the entire group into context.',
    defaultSeverity: Severity.error,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Three-way cluster',
        bad: `// a.ts
import { c } from './c'
export const a = 'a'

// b.ts
import { a } from './a'
export const b = 'b'

// c.ts
import { b } from './b'
export const c = 'c'`,
        good: `// core.ts
export const core = 'core'

// a.ts
import { core } from './core'
export const a = core + 'a'

// b.ts
import { core } from './core'
export const b = core + 'b'`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'circular-type-deps',
    group: DetectorGroup.dependency,
    scope: 'graph',
    title: 'Circular type-only imports',
    description:
      'Modules form a cycle exclusively through `import type` statements. TypeScript erases these at runtime, but the structural coupling still degrades architecture and tooling.',
    rationale:
      'Even though type-only cycles do not cause runtime errors, they tangle the conceptual graph. Refactoring tools (including AI assistants) that trace `import type` to understand data shapes will encounter the same confusion as runtime cycles. Circular type deps also indicate that type ownership is not clearly assigned to a leaf module.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Type-only cycle',
        bad: `// user.ts
import type { Order } from './order'
export interface User { orders: Order[] }

// order.ts
import type { User } from './user'
export interface Order { owner: User }`,
        good: `// entity-ids.ts
export type UserId = string
export type OrderId = string

// user.ts
import type { OrderId } from './entity-ids'
export interface User { orderIds: OrderId[] }

// order.ts
import type { UserId } from './entity-ids'
export interface Order { ownerId: UserId }`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'package-cycles',
    group: DetectorGroup.dependency,
    scope: 'graph',
    title: 'Cyclic package dependency',
    description:
      'Two or more monorepo packages list each other as dependencies, creating a cycle at the package graph level.',
    rationale:
      'Package-level cycles break workspace installation order, prevent independent versioning, and make it impossible to publish one package without the other. They signal that the package boundaries were drawn incorrectly and that shared code should be extracted into a third, depended-on package.',
    defaultSeverity: Severity.error,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Package A ↔ Package B',
        bad: `// packages/a/package.json (excerpt as comment)
// { "dependencies": { "@scope/b": "*" } }

// packages/b/package.json (excerpt as comment)
// { "dependencies": { "@scope/a": "*" } }

import { helpB } from '@scope/b'
export const helpA = () => helpB()`,
        good: `// packages/shared/package.json (excerpt as comment)
// { "dependencies": {} }

// packages/a depends on @scope/shared
// packages/b depends on @scope/shared

import { help } from '@scope/shared'
export const helpA = () => help()`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'layer-violation',
    group: DetectorGroup.dependency,
    scope: 'project',
    title: 'Layer violation (inner layer imports outer layer)',
    description:
      'A module in an inner architectural layer (e.g. domain, use-case) imports from an outer layer (e.g. controller, infrastructure), inverting the intended dependency direction.',
    rationale:
      'Clean layered architectures enforce that dependencies point inward: infrastructure → application → domain. When an inner layer reaches outward it becomes coupled to delivery mechanisms, making it impossible to test the core in isolation and difficult for AI to reason about pure business logic separately from framework concerns.',
    defaultSeverity: Severity.error,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Domain importing from controller',
        bad: `// domain/user.ts
import { UserController } from '../controllers/user-controller'

export class User {
  constructor(private ctrl: UserController) {}
}`,
        good: `// domain/user.ts
export class User {
  constructor(private readonly id: string) {}
}

// application/create-user.ts
import { User } from '../domain/user'
export const createUser = (id: string) => new User(id)`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: {
      status: 'partial',
      plugin: 'boundaries',
      rule: 'boundaries/dependencies',
      note: 'eslint-plugin-boundaries enforces element relationships at warn',
    },
  },
  {
    id: 'sdp-violation',
    group: DetectorGroup.dependency,
    scope: 'graph',
    title: 'Stable Dependencies Principle (SDP) violation',
    description:
      'A stable module (one that many others depend on) imports from a volatile module (one that changes frequently or has few dependents), coupling stability to instability.',
    rationale:
      'The Stable Dependencies Principle states that a module should only depend on modules that are more stable than itself. Violating SDP means a foundational module gets dragged into churn every time a volatile leaf changes. Architecturally, this is resolved by introducing an abstraction (interface or port) that the stable module depends on, letting volatile implementations vary independently.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Core utility importing experimental feature',
        bad: `// core/logger.ts  (stable — depended on by 40 modules)
import { experimentalTracer } from '../features/experimental-tracer'

export const log = (msg: string) => {
  experimentalTracer.record(msg)
  console.log(msg)
}`,
        good: `// core/logger.ts
export interface Tracer {
  record(msg: string): void
}

export const createLogger = (tracer: Tracer) => ({
  log: (msg: string) => {
    tracer.record(msg)
    console.log(msg)
  },
})`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
]
