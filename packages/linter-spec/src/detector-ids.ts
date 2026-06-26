/**
 * The single source of truth for detector ids, as a `const` tuple + derived
 * union — the same erasable-syntax-safe idiom used for {@link DetectorGroup}
 * and {@link Severity}. `Detector['id']` is typed as `DetectorId`, so a detector
 * authored with an id not listed here is a compile-time error, and the catalog
 * lookup (`Record<DetectorId, Detector>`) gets literal-keyed type safety.
 *
 * Listed in catalog (group) order. The sanity test guards that this tuple is a
 * bijection with the live detector ids, so it cannot silently drift.
 */
export const DETECTOR_IDS = [
  // dependency
  'cyclic-dependency',
  'cycle-clusters',
  'circular-type-deps',
  'package-cycles',
  'layer-violation',
  'sdp-violation',
  // module-design
  'god-module',
  'hub-module',
  'lcom',
  'high-coupling',
  'module-cohesion',
  'feature-envy',
  'import-fan-in',
  // code-quality
  'dead-code',
  'dead-symbols',
  'orphan-types',
  'barrel-file',
  'primitive-obsession',
  'commented-out-code',
  'unnecessary-condition',
  're-export-depth',
  // complexity
  'cyclomatic-complexity',
  'cognitive-complexity',
  'deep-nesting',
  'long-params',
  'large-file',
  // change-patterns
  'shotgun-surgery',
  'unstable-interface',
  // runtime-safety
  'test-leakage',
  'vendor-coupling',
  'hub-dependency',
  'side-effect-import',
  'shared-mutable-state',
  'redos-regex',
  'control-char-regex',
  'no-deprecated-node-api',
  'prefer-node-protocol',
  // metrics
  'abstractness',
  'scattered-config',
  'code-clone',
  // ai-agentic
  'cross-feature-import',
  'no-deep-relative-imports',
  'magic-number-string',
  'naming-convention',
  'public-api-surface',
  'implicit-any-escape-hatch',
  'todo-debt',
  'ai-context-bloat',
  'error-handling-consistency',
  'no-default-export',
  'comment-staleness',
  // async-correctness
  'floating-promise',
  'misused-promise',
  'only-throw-error',
] as const

export type DetectorId = (typeof DETECTOR_IDS)[number]
