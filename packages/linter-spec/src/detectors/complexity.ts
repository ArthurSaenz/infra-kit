import { DetectorGroup } from '#root/groups'
import { Severity } from '#root/severity'
import type { Detector } from '#root/types'

export const complexityDetectors: Detector[] = [
  {
    id: 'cyclomatic-complexity',
    group: DetectorGroup.complexity,
    scope: 'file',
    title: 'High cyclomatic complexity',
    description: 'Functions whose count of independent control-flow paths exceeds a threshold.',
    rationale:
      'Many branches are hard to test exhaustively and hard for an agent to follow; each path hides bugs. Cognitive complexity is the nesting-weighted, readability-oriented sibling — run cyclomatic for raw branch/path count, cognitive for how hard the function is to read (SonarSource treats cognitive as the readability successor).',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    options: [
      {
        name: 'threshold',
        type: 'number',
        default: 10,
        description: 'Max independent control-flow paths per function.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: {
      status: 'none',
      enabledInRepo: false,
      plugin: 'eslint-core',
      rule: 'complexity',
      note: 'core complexity rule installed but not enabled by @antfu/eslint-config lessOpinionated (absent from the resolved config)',
    },
    eslint: { messageId: 'tooComplex', fixable: null, recommended: true },
    examples: [
      {
        bad: `function grade(s: number) {
  if (s > 90) return 'A'
  else if (s > 80) return 'B'
  else if (s > 70) return 'C'
  else return 'F'
}`,
        good: `const BANDS = [[90, 'A'], [80, 'B'], [70, 'C']] as const
function grade(s: number) {
  return BANDS.find(([min]) => s > min)?.[1] ?? 'F'
}`,
      },
    ],
  },
  {
    id: 'cognitive-complexity',
    group: DetectorGroup.complexity,
    scope: 'file',
    title: 'High cognitive complexity',
    description:
      'Functions whose cognitive complexity score exceeds a threshold due to nested or interrupted control flow.',
    rationale:
      'Cognitive complexity penalises deeply nested and interrupted control flow more than cyclomatic complexity does. High scores indicate code that is genuinely hard to read, even when branch counts look acceptable.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    options: [
      { name: 'threshold', type: 'number', default: 15, description: 'Max cognitive complexity score per function.' },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: { status: 'covered', plugin: 'sonarjs', rule: 'sonarjs/cognitive-complexity' },
    eslint: { messageId: 'tooCognitive', fixable: null, recommended: true },
    examples: [
      {
        bad: `function process(items: string[]) {
  for (const item of items) {
    if (item.startsWith('A')) {
      if (item.length > 3) {
        console.log(item)
      }
    }
  }
}`,
        good: `function isLongA(item: string) {
  return item.startsWith('A') && item.length > 3
}
function process(items: string[]) {
  items.filter(isLongA).forEach(item => console.log(item))
}`,
      },
    ],
  },
  {
    id: 'deep-nesting',
    group: DetectorGroup.complexity,
    scope: 'file',
    title: 'Deeply nested blocks',
    description: 'Code blocks nested beyond a maximum depth threshold.',
    rationale:
      'Deep nesting forces readers to track many open scopes simultaneously. Guard clauses and early returns flatten the happy path and make the logic easier for both humans and agents to follow.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    options: [{ name: 'maxDepth', type: 'number', default: 4, description: 'Max block nesting depth.' }],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: {
      status: 'none',
      enabledInRepo: false,
      plugin: 'eslint-core',
      rule: 'max-depth',
      note: 'core max-depth installed but not enabled by @antfu/eslint-config lessOpinionated (absent from the resolved config)',
    },
    eslint: { messageId: 'tooDeep', fixable: null, recommended: false },
    examples: [
      {
        bad: `function run(a: boolean, b: boolean, c: boolean) {
  if (a) {
    if (b) {
      if (c) {
        doWork()
      }
    }
  }
}`,
        good: `function run(a: boolean, b: boolean, c: boolean) {
  if (!a || !b || !c) return
  doWork()
}`,
      },
    ],
  },
  {
    id: 'long-params',
    group: DetectorGroup.complexity,
    scope: 'file',
    title: 'Too many positional parameters',
    description: 'Functions that declare more positional parameters than the configured threshold.',
    rationale:
      'Long parameter lists are easy to call in the wrong order and hard to extend without breaking callers. An options object makes each argument self-documenting and allows optional fields without breaking changes.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    options: [
      {
        name: 'maxParams',
        type: 'number',
        default: 4,
        description: 'Max number of positional parameters per function.',
      },
    ],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: {
      status: 'none',
      enabledInRepo: false,
      plugin: 'eslint-core',
      rule: 'max-params',
      note: 'core max-params installed but not enabled by @antfu/eslint-config lessOpinionated (absent from the resolved config)',
    },
    eslint: { messageId: 'tooManyParams', fixable: null, recommended: false },
    examples: [
      {
        bad: `function createUser(name: string, age: number, email: string, role: string, active: boolean) {
  return { name, age, email, role, active }
}`,
        good: `interface UserOpts {
  name: string
  age: number
  email: string
  role: string
  active: boolean
}
function createUser(opts: UserOpts) {
  return { ...opts }
}`,
      },
    ],
  },
  {
    id: 'large-file',
    group: DetectorGroup.complexity,
    scope: 'file',
    title: 'Oversized source file',
    description: 'Source files that exceed a maximum line count threshold.',
    rationale:
      'Large files accumulate multiple responsibilities and become expensive to load into an agent context window. Splitting by responsibility improves cohesion and makes each unit easier to understand, test, and replace.',
    defaultSeverity: Severity.warn,
    appliesTo: 'any',
    status: 'stable',
    options: [{ name: 'maxLines', type: 'number', default: 400, description: 'Max number of lines per source file.' }],
    references: ['https://archlinter.github.io/archlint/detectors/'],
    existing: {
      status: 'none',
      enabledInRepo: false,
      plugin: 'eslint-core',
      rule: 'max-lines',
      note: 'core max-lines/max-lines-per-function installed but not enabled by @antfu/eslint-config lessOpinionated (absent from the resolved config)',
    },
    eslint: { messageId: 'tooManyLines', fixable: null, recommended: false },
    examples: [
      {
        bad: `// user.ts  (600 lines — auth, profile, settings, notifications all in one file)
export function login() { /* ... */ }
export function updateProfile() { /* ... */ }
export function saveSettings() { /* ... */ }
export function sendNotification() { /* ... */ }`,
        good: `// auth.ts
export function login() { /* ... */ }

// profile.ts
export function updateProfile() { /* ... */ }

// settings.ts
export function saveSettings() { /* ... */ }`,
      },
    ],
  },
]
