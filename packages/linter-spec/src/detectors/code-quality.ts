import { DetectorGroup } from '#root/groups'
import { Severity } from '#root/severity'
import type { Detector } from '#root/types'

export const codeQualityDetectors: Detector[] = [
  {
    id: 'dead-code',
    group: DetectorGroup.codeQuality,
    scope: 'graph',
    title: 'Dead Code (Unused Exports)',
    description: 'Flags exported symbols that are never imported by any other module in the graph.',
    rationale:
      'Exports that no consumer references are dead weight: they inflate the public surface, mislead readers, and slow down refactors. Removing them shrinks the mental model and makes the real API obvious.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'unused exported helper',
        bad: `// utils.ts
export function formatDate(d: Date): string {
  return d.toISOString()
}

export function legacyFormat(d: Date): string {
  return d.toLocaleDateString()
}

// No other file imports legacyFormat.`,
        good: `// utils.ts
export function formatDate(d: Date): string {
  return d.toISOString()
}

// legacyFormat removed — no consumers.`,
        note: 'Delete or wire up; do not leave dead exports as silent API surface.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'dead-symbols',
    group: DetectorGroup.codeQuality,
    scope: 'file',
    title: 'Dead Symbols (Unused Locals)',
    description: 'Flags local variables, parameters, or functions declared inside a file but never referenced.',
    rationale:
      'Unused locals are noise: they distract reviewers, mislead static analysis, and often indicate incomplete refactors. Removing them keeps files minimal and every name load-bearing.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'unused local variable',
        bad: `function buildLabel(name: string): string {
  const prefix = 'item'
  const unused = 42
  return prefix + '-' + name
}`,
        good: `function buildLabel(name: string): string {
  const prefix = 'item'
  return prefix + '-' + name
}`,
        note: 'Remove unused local; every declared name should be referenced.',
      },
    ],
    eslint: {
      messageId: 'unusedSymbol',
      fixable: null,
      recommended: true,
    },
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: {
      status: 'covered',
      plugin: 'unused-imports',
      rule: 'unused-imports/no-unused-vars',
      note: 'core/ts no-unused-vars are off; antfu delegates to unused-imports/no-unused-vars + no-unused-imports (both error in resolved config)',
    },
  },
  {
    id: 'orphan-types',
    group: DetectorGroup.codeQuality,
    scope: 'project',
    title: 'Orphan Types (Unreferenced Exported Types)',
    description:
      'Flags exported TypeScript types, interfaces, and type aliases that are imported nowhere in the project.',
    rationale:
      'Type exports that nothing references inflate the declared API just like dead value exports do. They confuse consumers ("should I use this?") and accumulate as the codebase evolves. Deleting or using them keeps the type surface intentional.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'exported type with no consumers',
        bad: `// models.ts
export type UserId = string

export interface LegacyUser {
  id: UserId
  name: string
}

// LegacyUser is never imported anywhere.`,
        good: `// models.ts
export type UserId = string

// LegacyUser deleted — no consumers reference it.`,
        note: 'Delete unused exported types or actually use them.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'barrel-file',
    group: DetectorGroup.codeQuality,
    scope: 'project',
    title: 'Barrel File (Over-Re-Exporting Index)',
    description:
      'Flags index files that re-export more symbols than the configured threshold, coupling every consumer to the entire module surface.',
    rationale:
      'A barrel that re-exports everything forces bundlers to pull in the whole module and makes dependency analysis opaque. Importing directly from the source file (or narrowing the barrel) keeps build graphs lean and refactors safe. See also public-api-surface: barrel-file and public-api-surface are two ends of one axis — barrel-file flags an index that re-exports too much, while public-api-surface flags a module with no public index at all.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'over-wide barrel',
        bad: `// index.ts (re-exports 30+ symbols)
export { Alpha } from './alpha'
export { Beta } from './beta'
export { Gamma } from './gamma'
export { Delta } from './delta'
// ... 26 more re-exports`,
        good: `// consumers import directly instead of through the mega-barrel
import { Alpha } from './alpha'
import { Beta } from './beta'`,
        note: 'Either remove the barrel and import directly, or narrow it to the intentional public API.',
      },
    ],
    options: [
      {
        name: 'maxReexports',
        type: 'number',
        default: 20,
        description: 'Maximum number of re-exports allowed in a single barrel/index file before the rule triggers.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'primitive-obsession',
    group: DetectorGroup.codeQuality,
    scope: 'file',
    title: 'Primitive Obsession',
    description:
      'Flags repetitive use of raw primitive types (string, number) in domain positions where a branded or named type would make intent explicit and prevent mix-ups.',
    rationale:
      'Raw strings and numbers are interchangeable to the type system even when they represent incompatible concepts (user ID vs. order ID, price vs. quantity). A thin branded type costs nothing at runtime while making wrong-argument bugs a compile error.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'raw string IDs with no domain type',
        bad: `function transferFunds(fromAccount: string, toAccount: string, amount: number): void {
  // Nothing stops the caller from swapping fromAccount and toAccount.
}`,
        good: `type AccountId = string & { readonly __brand: 'AccountId' }
type Cents = number & { readonly __brand: 'Cents' }

function transferFunds(fromAccount: AccountId, toAccount: AccountId, amount: Cents): void {
  // Compiler rejects string literals without the brand.
}`,
        note: 'Use a branded or opaque type for each distinct domain concept.',
      },
    ],
    eslint: {
      messageId: 'usePrimitiveType',
      fixable: null,
      recommended: false,
    },
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
  },
  {
    id: 'commented-out-code',
    group: DetectorGroup.codeQuality,
    scope: 'file',
    title: 'Commented-out code',
    description: 'Blocks of real code that have been commented out rather than deleted.',
    rationale:
      'Commented-out code is dead weight that version control already preserves. It misleads an agent into treating stale logic as live context, and rots silently as the surrounding code changes.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'commented block vs cleaned',
        bad: `export function total(items: number[]) {
  // const tax = 0.2
  // return items.reduce((a, b) => a + b, 0) * (1 + tax)
  return items.reduce((a, b) => a + b, 0)
}`,
        good: `export function total(items: number[]) {
  return items.reduce((a, b) => a + b, 0)
}`,
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: {
      status: 'none',
      enabledInRepo: false,
      plugin: 'sonarjs',
      rule: 'sonarjs/no-commented-code',
      note: 'rule installed but turned OFF in vendor/configs/eslint-config/index.js ("temporary disable, must be enabled")',
    },
    eslint: { messageId: 'commentedOutCode', fixable: null, recommended: false },
    tags: ['ai-agentic'],
  },
  {
    id: 'unnecessary-condition',
    group: DetectorGroup.codeQuality,
    scope: 'project',
    title: 'Unnecessary (always-true / always-false) condition',
    description:
      'A condition whose outcome is statically determined — always truthy or always falsy — so a branch is dead.',
    rationale:
      'A condition that can only go one way is dead logic an agent will misread as a real branch. The general case (e.g. a value that is never null) needs type narrowing across the program, hence project scope.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'always-truthy guard',
        bad: `function label(name: string) {
  if (name) {
    return name
  }
  return 'anon'
}`,
        good: `function label(name: string | undefined) {
  if (name) {
    return name
  }
  return 'anon'
}`,
        note: 'Illustrative/syntactic. The full rule (ts/no-unnecessary-condition) is type-dependent; sonarjs/no-gratuitous-expressions catches a runtime subset.',
      },
    ],
    references: ['https://typescript-eslint.io/rules/no-unnecessary-condition/'],
    existing: {
      status: 'partial',
      plugin: 'sonarjs',
      rule: 'sonarjs/no-gratuitous-expressions',
      note: 'sonarjs/no-gratuitous-expressions (error) catches a subset of always-true/false expressions; the full type-narrowing ts/no-unnecessary-condition is type-aware and dormant',
    },
    tags: ['ai-agentic'],
  },
  {
    id: 're-export-depth',
    group: DetectorGroup.codeQuality,
    scope: 'project',
    title: 'Deep re-export chain (barrel laundering)',
    description:
      'A symbol reachable only through multiple chained re-exports (index re-exporting from another index, repeatedly).',
    rationale:
      'Deep re-export chains are the #1 agent-navigation killer — to answer "where is this actually defined?" an agent must traverse N barrel hops. Each hop is a blind spot: the real declaration site is hidden behind layers of index files, making context retrieval unpredictable and symbol resolution expensive. Squarely agentic.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'chained re-export hops',
        bad: `// features/index.ts
export { thing } from './thing'

// thing/index.ts
export { thing } from './impl'

// impl/index.ts
export { thing } from './thing'`,
        good: `// import the concrete module directly — one hop
import { thing } from './features/thing/impl/thing'
export { thing }`,
      },
    ],
    options: [
      {
        name: 'maxDepth',
        type: 'number',
        default: 2,
        description: 'Max re-export hops to a concrete declaration.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'none' },
    tags: ['ai-agentic'],
  },
]
