import { DetectorGroup } from '#root/groups'
import { Severity } from '#root/severity'
import type { Detector } from '#root/types'

export const aiAgenticDetectors: Detector[] = [
  {
    id: 'cross-feature-import',
    group: DetectorGroup.aiAgentic,
    scope: 'project',
    title: 'Cross-Feature Import (Bypassing Barrel)',
    description: "Flags imports from a sibling feature's internal files, bypassing the feature's public barrel.",
    rationale:
      "AI agents navigate codebases by following public-API boundaries. When feature A reaches into feature B's internals, the dependency graph becomes unpredictable and impossible to summarize from index files alone. Forcing cross-feature traffic through a barrel gives agents a single, stable entry point per feature and keeps refactors contained.",
    defaultSeverity: Severity.warn,
    appliesTo: 'frontend',
    status: 'stable',
    examples: [
      {
        label: 'direct internal import from sibling feature',
        bad: `// features/checkout/CheckoutForm.tsx
import { useCartStore } from '../cart/store/cartStore'
// Reaching into cart's internals — bypasses the public barrel.`,
        good: `// features/checkout/CheckoutForm.tsx
import { useCartStore } from '../cart'
// Imported from the cart feature's public barrel index.`,
        note: 'If the symbol is not on the barrel, lift it there or extract to a shared module.',
      },
    ],
    options: [
      {
        name: 'mode',
        type: 'enum',
        enum: ['strict', 'type-only'],
        default: 'type-only',
        description: 'Whether sibling features may cross-import types only or not at all.',
      },
    ],
    existing: {
      status: 'covered',
      plugin: 'boundaries',
      rule: 'no-restricted-imports',
      note: 'no-restricted-imports + boundaries enforce feature barrels/relationships.',
    },
    tags: ['ai-agentic'],
  },
  {
    id: 'no-deep-relative-imports',
    group: DetectorGroup.aiAgentic,
    scope: 'file',
    title: 'Deep Relative Import',
    description: 'Flags relative import paths with more ../ hops than the configured threshold.',
    rationale:
      'Chains of ../../.. make it impossible for an agent to determine module ownership without resolving the full path. Path aliases like #root/ are self-describing: they communicate intent and remain stable when files move, giving agents a reliable mental model of the codebase layout.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'deeply nested relative import',
        bad: `import { formatDate } from '../../../../lib/date/formatDate'`,
        good: `import { formatDate } from '#root/lib/date/formatDate'`,
        note: 'Use a path alias; the alias communicates origin, the relative chain does not.',
      },
    ],
    eslint: {
      messageId: 'deepRelativeImport',
      fixable: null,
      recommended: true,
    },
    options: [
      {
        name: 'maxDepth',
        type: 'number',
        default: 2,
        description: 'Max ../ hops allowed in a relative import.',
      },
    ],
    existing: { status: 'none' },
    tags: ['ai-agentic'],
  },
  {
    id: 'magic-number-string',
    group: DetectorGroup.aiAgentic,
    scope: 'file',
    title: 'Magic Number or String Literal',
    description: 'Flags unexplained numeric or string literals used directly in logic without a named constant.',
    rationale:
      'An agent reading a function that compares against 86400 cannot know if that is seconds-per-day, a limit, or a legacy ID. A named constant (SECONDS_PER_DAY) is self-documenting: it gives agents the vocabulary to reason about intent without requiring broader context.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'inline magic number',
        bad: `function isSessionExpired(ageSeconds: number): boolean {
  return ageSeconds > 86400
}`,
        good: `const SECONDS_PER_DAY = 86400

function isSessionExpired(ageSeconds: number): boolean {
  return ageSeconds > SECONDS_PER_DAY
}`,
        note: 'Extract the literal into a named constant that declares its meaning.',
      },
    ],
    eslint: {
      messageId: 'magicLiteral',
      fixable: null,
      recommended: false,
    },
    options: [
      {
        name: 'ignore',
        type: 'string[]',
        default: ['0', '1', '-1'],
        description: 'Literals exempt from the rule.',
      },
    ],
    existing: { status: 'partial', plugin: 'eslint-core', rule: 'no-magic-numbers' },
    tags: ['ai-agentic'],
  },
  {
    id: 'naming-convention',
    group: DetectorGroup.aiAgentic,
    scope: 'file',
    title: 'Inconsistent or Opaque Naming Convention',
    description: 'Flags identifiers that do not follow the configured casing convention for their symbol kind.',
    rationale:
      'AI agents use naming conventions as structural signals: PascalCase implies a component or class, camelCase a function or variable, CONSTANT_CASE a fixed value. Cryptic or inconsistently cased names like `const d = ...` strip away that signal, forcing the agent to read more code to understand context. Consistent, descriptive names make every identifier self-classifying.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'abbreviated, opaque variable name',
        bad: `function proc(d: Date, n: number): string {
  const r = d.toISOString().slice(0, 10)
  return r.repeat(n)
}`,
        good: `function formatDateRepeated(date: Date, repeatCount: number): string {
  const isoDate = date.toISOString().slice(0, 10)
  return isoDate.repeat(repeatCount)
}`,
        note: 'Every name should describe what it holds, not just how long it is.',
      },
    ],
    eslint: {
      messageId: 'badName',
      fixable: null,
      recommended: false,
    },
    options: [
      {
        name: 'convention',
        type: 'enum',
        enum: ['camelCase', 'PascalCase', 'CONSTANT_CASE', 'kebab-case'],
        description: 'Required casing per symbol kind.',
      },
    ],
    existing: { status: 'partial', plugin: 'eslint-core', rule: 'ts/naming-convention' },
    tags: ['ai-agentic'],
  },
  {
    id: 'public-api-surface',
    group: DetectorGroup.aiAgentic,
    scope: 'project',
    title: 'Missing or Implicit Public API Surface',
    description:
      'Flags modules that have no clear public entry point, allowing consumers to reach into internal files.',
    rationale:
      'When a module exposes no explicit public API, agents must scan all of its files to understand what is intended for consumption. A single index barrel collapses that surface to one file: agents read the barrel to understand the module, internals to understand implementation — a predictable, two-level contract that scales with codebase size.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'module with no barrel — consumers reach into internals',
        bad: `// No index.ts in the module.
// consumers must guess:
import { parseConfig } from './config/parser/parseConfig'
import { validateConfig } from './config/validator/validateConfig'`,
        good: `// config/index.ts — the single public entry point
export { parseConfig } from './parser/parseConfig'
export { validateConfig } from './validator/validateConfig'

// consumers import from the barrel:
import { parseConfig, validateConfig } from './config'`,
        note: 'One barrel file = one place for an agent to discover everything a module intentionally exposes.',
      },
    ],
    options: [
      {
        name: 'style',
        type: 'enum',
        enum: ['index-barrel', 'named'],
        default: 'index-barrel',
        description: 'How a module exposes its public API.',
      },
    ],
    existing: { status: 'partial', plugin: 'eslint-core', rule: 'no-restricted-imports' },
    tags: ['ai-agentic'],
  },
  {
    id: 'implicit-any-escape-hatch',
    group: DetectorGroup.aiAgentic,
    scope: 'file',
    title: 'Implicit Any / Type Escape Hatch',
    description:
      'Flags uses of `as any`, explicit `any` annotations, and unsafe type assertions that defeat the type system.',
    rationale:
      'AI agents rely on type information to reason about data flow without running the program. Every `as any` punches a hole in that model: downstream the agent sees an untyped value and must fall back to reading all call sites to reconstruct intent. `unknown` + narrowing or a precise type preserves the information the agent needs.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'casting to any to silence a type error',
        bad: `function processPayload(raw: unknown): string {
  return (raw as any).value.trim()
}`,
        good: `interface Payload {
  value: string
}

function isPayload(raw: unknown): raw is Payload {
  return typeof raw === 'object' && raw !== null && 'value' in raw
}

function processPayload(raw: unknown): string {
  if (!isPayload(raw)) throw new Error('Invalid payload')
  return raw.value.trim()
}`,
        note: 'Narrow `unknown` explicitly; an agent can follow the narrowing, it cannot follow `any`.',
      },
    ],
    eslint: {
      messageId: 'anyEscapeHatch',
      fixable: null,
      recommended: true,
    },
    options: [
      {
        name: 'allow',
        type: 'string[]',
        default: [],
        description: 'Files/globs allowed to use any.',
      },
    ],
    existing: { status: 'partial', plugin: 'eslint-core', rule: 'ts/no-explicit-any' },
    tags: ['ai-agentic'],
  },
  {
    id: 'todo-debt',
    group: DetectorGroup.aiAgentic,
    scope: 'file',
    title: 'Untracked TODO / Technical Debt Marker',
    description: 'Flags TODO, FIXME, HACK, and similar comment tags that have no associated ticket reference.',
    rationale:
      'An agent reading `// TODO: clean this up` gains no actionable signal — it does not know if the debt is tracked, who owns it, or whether it is safe to delete the surrounding code. A comment like `// TODO(PROJ-123): migrate to new API` is agent-readable: it links to a canonical record, scopes the work, and distinguishes acknowledged debt from accidental omissions.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'untracked TODO comment',
        bad: `// TODO: remove this once the migration is done
function legacyTransform(input: string): string {
  return input.toLowerCase()
}`,
        good: `// TODO(INFRA-456): remove after migration to v2 transform completes
function legacyTransform(input: string): string {
  return input.toLowerCase()
}`,
        note: 'Every debt marker should link to a ticket so agents and humans can verify current status.',
      },
    ],
    eslint: {
      messageId: 'todoDebt',
      fixable: null,
      recommended: false,
    },
    options: [
      {
        name: 'tags',
        type: 'string[]',
        default: ['TODO', 'FIXME', 'HACK', 'XXX'],
        description: 'Comment tags treated as tracked debt.',
      },
    ],
    existing: { status: 'covered', plugin: 'sonarjs', rule: 'sonarjs/todo-tag' },
    tags: ['ai-agentic'],
  },
  {
    id: 'ai-context-bloat',
    group: DetectorGroup.aiAgentic,
    scope: 'file',
    title: 'AI Context Bloat (Too Many Exports per Module)',
    description:
      'Flags modules that export more distinct symbols than the configured threshold, exceeding a reasonable agent working-memory budget.',
    rationale:
      'When an agent loads a module to understand it, every exported symbol is a separate concept to track. A module exporting 30 unrelated utilities forces the agent to hold all 30 in context simultaneously. Splitting into focused modules with fewer exports lets an agent load only what is relevant — smaller surface, faster comprehension, fewer hallucinations about symbol relationships. Metric is export count, not line count, to stay distinct from large-file detectors.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'catch-all utilities module with dozens of exports',
        bad: `// utils.ts — exports 25+ unrelated symbols
export function formatDate(d: Date): string { return d.toISOString() }
export function slugify(s: string): string { return s.toLowerCase() }
export const MAX_RETRIES = 3
export type Maybe<T> = T | null
// ... 21 more exports`,
        good: `// date/formatDate.ts
export function formatDate(d: Date): string { return d.toISOString() }

// string/slugify.ts
export function slugify(s: string): string { return s.toLowerCase() }

// http/constants.ts
export const MAX_RETRIES = 3`,
        note: 'Split by responsibility; each focused module can be understood in isolation.',
      },
    ],
    eslint: {
      messageId: 'tooManyExports',
      fixable: null,
      recommended: false,
    },
    options: [
      {
        name: 'maxExports',
        type: 'number',
        default: 15,
        description: "Max distinct exported symbols per module before it exceeds an agent's working-memory budget.",
      },
    ],
    existing: {
      status: 'none',
      note: 'Distinct from large-file: counts distinct exported symbols, not lines.',
    },
    tags: ['ai-agentic'],
  },
  {
    id: 'error-handling-consistency',
    group: DetectorGroup.aiAgentic,
    scope: 'file',
    title: 'Inconsistent Error Handling',
    description:
      'Flags catch blocks that silently swallow errors without rethrowing, logging, or returning a typed result.',
    rationale:
      'An agent tracing a failure path through code that uses bare `catch {}` loses the trail entirely — there is no signal to follow. A consistent policy (typed Result, structured rethrow with context, or at minimum a logged error) gives agents predictable error-flow shapes to reason about. This rule is proposed pending a declared project error policy baseline.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'proposed',
    examples: [
      {
        label: 'silent catch swallowing an error',
        bad: `async function loadConfig(path: string): Promise<Config | null> {
  try {
    const text = await fs.readFile(path, 'utf8')
    return JSON.parse(text) as Config
  } catch {
    return null
  }
}`,
        good: `async function loadConfig(path: string): Promise<Config | null> {
  try {
    const text = await fs.readFile(path, 'utf8')
    return JSON.parse(text) as Config
  } catch (err) {
    console.error('Failed to load config', { path, err })
    return null
  }
}`,
        note: 'At minimum log the error with context so agents and humans can trace the failure.',
      },
    ],
    eslint: {
      messageId: 'inconsistentErrorHandling',
      fixable: null,
      recommended: false,
    },
    existing: {
      status: 'none',
      note: 'Needs a declared project error policy baseline before it is enforceable.',
    },
    tags: ['ai-agentic'],
  },
]
