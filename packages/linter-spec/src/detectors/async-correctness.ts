import { DetectorGroup } from '#root/groups'
import { Severity } from '#root/severity'
import type { Detector } from '#root/types'

export const asyncCorrectnessDetectors: Detector[] = [
  {
    id: 'floating-promise',
    group: DetectorGroup.asyncCorrectness,
    scope: 'project',
    title: 'Floating (un-awaited) promise',
    description: 'A Promise-returning call whose result is never awaited, returned, or explicitly voided.',
    rationale:
      "An un-awaited promise is an invisible control-flow edge: errors become unhandled rejections and ordering is non-deterministic. An agent reading the code cannot tell the call is async, so it mis-models execution. Deciding this reliably needs the callee's return type, hence project scope.",
    defaultSeverity: Severity.error,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'un-awaited async call',
        bad: `async function save(): Promise<void> {}
async function handler() {
  save()
}`,
        good: `async function save(): Promise<void> {}
async function handler() {
  await save()
}`,
        note: 'Illustrative/syntactic. The real rule (ts/no-floating-promises) is type-dependent: whether a call floats depends on its resolved return type across modules.',
      },
    ],
    references: ['https://typescript-eslint.io/rules/no-floating-promises/'],
    existing: {
      status: 'none',
      enabledInRepo: false,
      plugin: '@typescript-eslint',
      rule: 'ts/no-floating-promises',
      note: 'type-aware rule, dormant — no tsconfigPath passed to antfu, so it never runs',
    },
    tags: ['ai-agentic'],
  },
  {
    id: 'misused-promise',
    group: DetectorGroup.asyncCorrectness,
    scope: 'project',
    title: 'Promise used where a sync value is expected',
    description: 'A Promise passed to a position expecting a non-Promise (a boolean condition, a void callback, etc.).',
    rationale:
      'A Promise is always truthy and never the awaited value, so `if (asyncCheck())` and `arr.forEach(async ...)` silently misbehave. These bugs are invisible to a reader who cannot see the function is async. Detecting the type mismatch needs whole-program type info, hence project scope.',
    defaultSeverity: Severity.error,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'Promise in a boolean condition',
        bad: `async function isReady(): Promise<boolean> {
  return true
}
async function gate() {
  if (isReady()) {
    // always truthy: a Promise is not a boolean
  }
}`,
        good: `async function isReady(): Promise<boolean> {
  return true
}
async function gate() {
  if (await isReady()) {
    // ...
  }
}`,
        note: 'Illustrative/syntactic. The real rule (ts/no-misused-promises) is type-dependent.',
      },
    ],
    references: ['https://typescript-eslint.io/rules/no-misused-promises/'],
    existing: {
      status: 'none',
      enabledInRepo: false,
      plugin: '@typescript-eslint',
      rule: 'ts/no-misused-promises',
      note: 'type-aware rule, dormant — no tsconfigPath passed to antfu, so it never runs',
    },
    tags: ['ai-agentic'],
  },
  {
    id: 'only-throw-error',
    group: DetectorGroup.asyncCorrectness,
    scope: 'file',
    title: 'Throw Error objects, not literals',
    description: 'Throwing a string, number, or plain object instead of an Error (or subclass).',
    rationale:
      'A thrown non-Error has no stack trace and no consistent shape, so error tracing and typed catch handling break. Agents (and humans) rely on `error instanceof Error`; literal throws defeat it.',
    defaultSeverity: Severity.error,
    appliesTo: 'any',
    status: 'stable',
    examples: [
      {
        label: 'string throw',
        bad: `function parse(input: string) {
  if (!input) {
    throw 'input is required'
  }
}`,
        good: `function parse(input: string) {
  if (!input) {
    throw new Error('input is required')
  }
}`,
      },
    ],
    references: ['https://typescript-eslint.io/rules/only-throw-error/'],
    existing: {
      status: 'covered',
      plugin: 'eslint-core',
      rule: 'no-throw-literal',
      note: 'core no-throw-literal (error) catches literal throws; the type-aware ts/only-throw-error (which also flags thrown non-Error objects) is dormant',
    },
    eslint: { messageId: 'onlyThrowError', fixable: null, recommended: true },
  },
]
