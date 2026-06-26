/**
 * @pkg/linter-spec — a declarative catalog of code-architecture linter
 * detectors. Pure data + types, no detection logic. Tool-agnostic but shaped so
 * the `scope: 'file'` subset can map onto ESLint rules.
 */
export * from '#root/catalog'
export * from '#root/detector-ids'
export * from '#root/detectors/ai-agentic'
export * from '#root/detectors/async-correctness'
export * from '#root/detectors/change-patterns'
export * from '#root/detectors/code-quality'
export * from '#root/detectors/complexity'
export * from '#root/detectors/dependency'
export * from '#root/detectors/metrics'
export * from '#root/detectors/module-design'
export * from '#root/detectors/runtime-safety'
export * from '#root/groups'
export * from '#root/layers'
export * from '#root/severity'
export * from '#root/types'
