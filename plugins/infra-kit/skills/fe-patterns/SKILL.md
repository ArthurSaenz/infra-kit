---
name: fe-patterns
description: Analyze how features talk to each other — feature boundaries, the three component injection patterns, cross-feature type extraction, page-level orchestration, and where a component should live once a second feature wants it. Activate when reviewing feature boundaries, debugging cross-feature data flow, resolving a cross-feature import violation, deciding between element/component/render-function injection, or judging whether a component should be promoted to shared. For everything inside a single feature — naming rules, dumb vs smart, state scope, container guards — use fe-architect.
allowed-tools: Read, Glob, Grep, Bash(node "${CLAUDE_PLUGIN_ROOT}"/skills/fe-architect/scripts/analyze_imports.mjs *)
---

# Cross-Feature Patterns

## Overview

Everything about the seams between features: what may cross them, what must not, and the three
ways one feature hands work to another. Composition happens at the page level and nowhere else.

**Scope boundary.** This skill covers Rule 1 (no cross-feature imports) and the patterns that make
it livable. Rules 2–7 govern the inside of a feature and live in `fe-architect`:

| You are asking about | Skill |
|---|---|
| Can feature A import from feature B? How do they share data? | **this skill** |
| Which injection pattern — element, component, or render function? | **this skill** |
| Extracting a type across a feature boundary | **this skill** |
| Should this component be promoted to `shared`? | **this skill** |
| Atom naming, `Fx` suffix, service export names | `fe-architect` → [rules.md](../fe-architect/references/core/rules.md) |
| Dumb vs smart, container loading/error/empty guards | `fe-architect` → [enforcement.md](../fe-architect/references/core/enforcement.md) |
| State scope, splitting, error strategy, optimistic updates | `fe-architect` → [decisions.md](../fe-architect/references/patterns/decisions.md) |
| Creating or scaffolding a feature | `fe-architect` |

## When to Activate

- Cross-feature data flow analysis, or debugging an injection pattern
- A Rule 1 violation — a feature importing another feature at runtime
- Choosing between element / component / render-function injection
- Extracting a type across a boundary (`ExtractedAtomType`, `ExtractAtomActionArgs`, `ExtractAtomSetter`)
- Deciding whether a component belongs to a feature or to `shared`
- Auditing feature boundaries across an app

## The 5 Golden Rules

1. **No runtime imports between features** — `import type` is fine; everything else is forbidden
2. **Page orchestrates, features execute** — pages are the only place two features meet
3. **Props are the only interface** — never shared atoms, never direct service calls
4. **Type-only coupling is acceptable** — `import type` keeps features structurally independent
5. **Composition over configuration** — pass components/elements/render functions, not feature flags

## Injection Patterns Quick Reference

| Pattern | When to Use | Prop Type |
|---------|-------------|-----------|
| Element | Simple slots, no customization (icons, badges) | `React.ReactElement` |
| Component | The receiving feature controls what props to pass | `React.ComponentType<Props>` |
| Render Function | The consumer needs the feature's own data, or closures | `(props) => ReactElement` |

> Start with Element. Escalate to Component when the receiver must pass props. Escalate to Render
> Function when the consumer needs conditional rendering or page-level scope.

## Type Extraction Quick Reference

All three come from `@wl/web-toolkit` and carry no runtime dependency.

| Utility | Use Case | Input |
|---------|----------|-------|
| `ExtractedAtomType<T>` | Read-only: extract atom value type | State/derived atom |
| `ExtractAtomActionArgs<T>` | Write-only: extract action argument type | Write-only atom (`Fx`/`Atom`) |
| `ExtractAtomSetter<T>` | Read-write: extract setter function signature | Writable atom |

For plain domain types a feature exports, use `import type` directly.

## What tooling catches, and what it misses

Rule 1 is the one rule with real lint coverage. Check what is in force for the file in front of you
— `pnpm exec eslint --print-config <file>` — rather than trusting a severity written down in a
skill; those go stale.

The gap lint leaves: only code under a `features/` directory is classified at all. Anything outside
one is unpoliced. `fe-architect/scripts/analyze_imports.mjs` covers that — but nothing runs it for
you:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/skills/fe-architect/scripts/analyze_imports.mjs [features-path]
```

## Reference Index

| Reference | Content | Search Hints |
|-----------|---------|--------------|
| [cross-feature.md](./references/cross-feature.md) | 5 golden rules and why they exist, lint coverage and its gaps, 3 injection patterns with code, pattern selection matrix, service access, type extraction variants, page-level state sharing, shared-vs-feature promotion, common mistakes | `## 5 Golden Rules`, `## How much of this does tooling catch`, `## 3 Component Injection`, `## Service Access`, `## Type Extraction`, `## Shared vs Feature`, `## Common Mistakes` |

Cross-skill: [rules.md](../fe-architect/references/core/rules.md) (canonical 7 rules) ·
[enforcement.md](../fe-architect/references/core/enforcement.md) (rule → enforcement mapping,
Rules 6–7 expanded) · [decisions.md](../fe-architect/references/patterns/decisions.md) (7
intra-feature decision trees) ·
[example-style.md](../fe-architect/references/example-style.md) (how long a code example in these
docs may be)
