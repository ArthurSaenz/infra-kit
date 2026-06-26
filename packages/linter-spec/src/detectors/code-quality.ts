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
    existing: { status: 'covered', plugin: 'eslint-core', rule: 'no-unused-vars' },
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
      'A barrel that re-exports everything forces bundlers to pull in the whole module and makes dependency analysis opaque. Importing directly from the source file (or narrowing the barrel) keeps build graphs lean and refactors safe.',
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
]
