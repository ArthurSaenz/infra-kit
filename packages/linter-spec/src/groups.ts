/**
 * Top-level detector groups (taxonomy). The first seven mirror archlint's
 * categories; `ai-agentic` is our own bucket for rules that keep a codebase
 * legible to AI agents (predictable structure, small surfaces, clear
 * boundaries, self-describing names).
 *
 * `const` object + derived union (not a TS `enum`): erasable-syntax-safe and
 * iterable at runtime — the catalog's `detectorsByGroup` projection and the
 * sanity test both enumerate these.
 */
export const DetectorGroup = {
  /** Circular and structural dependency problems. */
  dependency: 'dependency',
  /** Module/class architecture: cohesion, coupling, responsibilities. */
  moduleDesign: 'module-design',
  /** Unused code and structural organization concerns. */
  codeQuality: 'code-quality',
  /** Size and complexity metrics. */
  complexity: 'complexity',
  /** Modification-frequency and stability signals. */
  changePatterns: 'change-patterns',
  /** Production-safety and coupling-to-the-outside concerns. */
  runtimeSafety: 'runtime-safety',
  /** Higher-level architectural metrics. */
  metrics: 'metrics',
  /** Custom rules for AI-agentic legibility (our own extensions). */
  aiAgentic: 'ai-agentic',
} as const

// eslint-disable-next-line ts/no-redeclare -- intentional const-object + derived-union idiom
export type DetectorGroup = (typeof DetectorGroup)[keyof typeof DetectorGroup]

/** Every group value, for iteration/validation. */
export const DETECTOR_GROUPS: readonly DetectorGroup[] = Object.values(DetectorGroup)
