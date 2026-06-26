import type { DetectorId } from '#root/detector-ids'
import type { DetectorGroup } from '#root/groups'
import type { Severity } from '#root/severity'

/**
 * How much program context a detector needs to run. This is the load-bearing
 * honesty field: it tells you *which* detectors could ever become ESLint rules.
 *
 * - `file`    — decidable from a single file's AST. Can be an ESLint rule.
 * - `project` — needs a cross-file/module index (who exports/imports what).
 *               Not a per-file ESLint rule.
 * - `graph`   — needs the whole dependency graph (cycles, reachability, clones).
 *               Cannot be an ESLint rule at all.
 *
 * `Object.values(detectors).filter(d => d.scope === 'file')` is the
 * ESLint-rule-able subset.
 */
export type DetectorScope = 'file' | 'project' | 'graph'

/** Which side of the stack a detector is meant for. */
export type Surface = 'backend' | 'frontend' | 'both' | 'any'

/**
 * `stable`   — fully specified with a measurable threshold and examples.
 * `proposed` — idea captured, but the metric/threshold is not yet pinned down.
 */
export type DetectorStatus = 'stable' | 'proposed'

/** A bad/good code pair illustrating a single detector. */
export interface DetectorExample {
  /** Optional short label distinguishing multiple examples on one detector. */
  label?: string
  /** Code that the detector should flag. */
  bad: string
  /** Code that resolves the violation. */
  good: string
  /** Optional clarifying note about the contrast. */
  note?: string
}

/**
 * A single configurable option, described as plain data (deliberately NOT zod).
 * This converts mechanically to both a TS type and an ESLint JSON schema — the
 * tool-agnostic seam — while staying JSON-serializable and legible in a diff.
 */
export interface DetectorOption {
  name: string
  type: 'number' | 'string' | 'boolean' | 'enum' | 'string[]'
  /** Default value, when the detector has a sensible one. */
  default?: unknown
  /** Allowed values when `type` is `'enum'`. */
  enum?: string[]
  description: string
}

/** A linter/plugin already present in the repo's toolchain. */
export type ExistingPlugin = 'sonarjs' | 'boundaries' | 'slip-stream-kit' | 'eslint-core' | (string & {})

/**
 * Records whether the repo's existing ESLint chain already covers this detector.
 * Makes the catalog an honest gap-map rather than a greenfield re-spec.
 *
 * - `covered` — an existing rule enforces the SAME invariant.
 * - `partial` — an existing rule catches a SUBSET/approximation.
 * - `none`    — no existing rule; a genuine gap (the catalog's real value).
 */
export interface ExistingCoverage {
  status: 'covered' | 'partial' | 'none'
  plugin?: ExistingPlugin
  rule?: string
  /** Optional note on what is/isn't covered. */
  note?: string
}

/**
 * Data-only descriptor of how a `file`-scope detector would map onto an ESLint
 * rule's `meta`. No `eslint` import — this is a shape, not a binding.
 */
export interface EslintSeam {
  messageId: string
  messages?: Record<string, string>
  fixable?: 'code' | 'whitespace' | null
  recommended?: boolean
}

/** Fields shared by every detector, independent of scope. */
interface DetectorBase {
  /** Stable, unique, kebab-case identifier (a member of {@link DetectorId}). */
  id: DetectorId
  group: DetectorGroup
  /** Human-readable title. */
  title: string
  /** What the detector flags. */
  description: string
  /** Why it matters (the architectural/legibility rationale). */
  rationale: string
  defaultSeverity: Severity
  appliesTo: Surface
  status: DetectorStatus
  /** At least one bad/good pair. */
  examples: DetectorExample[]
  /** Configurable thresholds/options, as plain data. */
  options?: DetectorOption[]
  /** External references (e.g. the archlint detector page). */
  references?: string[]
  /** Coverage by the repo's existing ESLint chain. */
  existing?: ExistingCoverage
  /** Free-form tags (e.g. `'ai-agentic'`). */
  tags?: string[]
}

/**
 * A detector definition. Discriminated on `scope` so the ESLint seam is
 * structurally impossible to attach to `project`/`graph` detectors that could
 * never be ESLint rules.
 */
export type Detector =
  | (DetectorBase & { scope: 'file'; eslint: EslintSeam })
  | (DetectorBase & { scope: 'project' | 'graph'; eslint?: null })

// ── Layer / segment models ──────────────────────────────────────────────────

/** A single layer (or feature segment) in a model. */
export interface LayerDef {
  name: string
  /** Position in the stack; lower order = more concrete/outer (e.g. controller=0). */
  order: number
  description: string
}

/**
 * An explicit dependency rule. Used for the rare legal cross-cut that the
 * derived `direction` matrix would otherwise forbid (or to document an
 * intentionally forbidden edge).
 */
export interface DependencyRule {
  from: string
  to: string
  allowed: boolean
  rationale?: string
}

/**
 * Declarative layer model. The full legal-dependency matrix is DERIVED from
 * `layers` (their `order`) + `direction`, not hand-authored:
 *
 * - `direction: 'downward'` — a layer may depend only on lower-`order` layers.
 *
 * `exceptions` carry the handful of edges that deviate from the derived rule.
 * This is the data that feeds `layer-violation` / `sdp-violation` /
 * `cross-feature-import`.
 */
export interface LayerModel {
  id: string
  title: string
  description: string
  layers: LayerDef[]
  direction: 'downward'
  /** Whether sideways (same-order) dependencies are allowed by default. */
  allowSameOrder?: boolean
  exceptions?: DependencyRule[]
  /** `true` for the generic, portable templates; `false`/absent for concrete instances. */
  generic?: boolean
}

/** A `SegmentModel` is structurally identical to a `LayerModel` — alias for clarity. */
export type SegmentModel = LayerModel
