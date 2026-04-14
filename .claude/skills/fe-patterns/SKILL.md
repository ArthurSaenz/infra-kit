---
name: fe-patterns
description: Analyze cross-feature communication patterns, enforce architectural rules with expanded rationale, and navigate component/state decision trees. Activate when reviewing feature boundaries, debugging cross-feature data flow, resolving rule violations with deeper WHY context, deciding between dumb vs smart components, choosing state scope, or auditing architecture. Complements fe-architect (creation workflows) with analysis and review depth.
version: 1.0.0
tags: [react, typescript, jotai, architecture, patterns, review, enforcement, decisions]
author: Feature Architecture Team
license: MIT
---

# Frontend Patterns & Decisions

## Overview

Detailed patterns, enforcement rationale, and architectural decision trees for the feature-based frontend architecture. Use this skill for cross-feature analysis, rule enforcement review, and architectural decision-making. For creating or modifying features, use `fe-architect` instead.

## When to Activate

- Cross-feature data flow analysis or debugging injection patterns
- Rule violation review requiring deeper WHY rationale (not just fix recipes)
- Deciding dumb vs smart component boundaries
- Choosing state scope (local vs feature atom vs page-level)
- Type extraction across feature boundaries (`ExtractedAtomType`, `ExtractAtomActionArgs`, `ExtractAtomSetter`)
- Service architecture decisions (single file vs folder, splitting thresholds)
- Architecture audits or code review of feature structure
- Evaluating error handling or optimistic update strategies

## Cross-Feature Patterns Quick Reference

| Pattern | When to Use | Prop Type |
|---------|-------------|-----------|
| Element | Simple slots, no customization (icons, badges) | `React.ReactElement` |
| Component | Parent controls what props to pass | `React.ComponentType<Props>` |
| Render Function | Full control over rendering logic and context | `(props) => ReactElement` |

> Decision: Start with Element. Escalate to Component if the consumer needs to pass props. Escalate to Render Function if the consumer needs conditional rendering or access to local scope.

See [cross-feature.md](./references/cross-feature.md) for full examples, pros/cons, type extraction utilities (`ExtractedAtomType`, `ExtractAtomActionArgs`, `ExtractAtomSetter`), and the pattern selection matrix.

## Enforcement Tiers

### Blocking (STOP immediately)

All 7 rules from [fe-architect rules.md](../fe-architect/references/core/rules.md) are blocking. The two rules most often requiring expanded context:

| Rule | Summary | Common Trigger |
|------|---------|----------------|
| Rule 5 | Dumb component purity — no atoms, services, API calls | Importing `useAtomValue` in a `-component.tsx` file |
| Rule 7 | Container state handling — loading/error/empty guards | Missing guard clauses, using loading for refetch |

### Warning (flag but don't block)

- Component exceeding 150 lines (split candidate)
- `services.ts` exceeding 250 lines or 3+ endpoints (folder candidate)
- Props interface with 8+ properties (composition candidate)
- Inline types instead of named interfaces for public APIs

See [enforcement.md](./references/enforcement.md) for expanded Rule 5, Rule 7, WHY rationale for all rules, and the 6-step enforcement workflow.

## Decision Trees

8 decision trees are available in [decisions.md](./references/decisions.md) covering:

| # | Decision | Quick Rule of Thumb |
|---|----------|---------------------|
| 1 | Dumb vs Smart component | Imports atoms/services? → Smart. Otherwise → Dumb |
| 2 | `services.ts` vs `services/` folder | >3 endpoints OR >250 lines → folder |
| 3 | State scope | UI-only → `useState`; shared in feature → atom; cross-feature → page props |
| 4 | Props interface vs inline type | Exported component → always named interface |
| 5 | Shared vs feature component | Used by 3+ features with zero business logic → shared |
| 6 | Component splitting | >150 lines → split |
| 7 | Error handling strategy | Network → `$error` atom; Validation → field-level; ServerError → show message |
| 8 | Optimistic updates | User-initiated + >95% success + visible change → optimistic |

Search hints for `decisions.md`: `## 1. Dumb vs Smart`, `## 2. services.ts`, `## 3. State Scope`, `## 7. Error Handling`, `## 8. Optimistic`.

## Type Extraction Quick Reference

| Utility | Use Case | Input |
|---------|----------|-------|
| `ExtractedAtomType<T>` | Read-only: extract atom value type | State/derived atom |
| `ExtractAtomActionArgs<T>` | Write-only: extract action argument type | Write-only atom (`Fx`/`Atom`) |
| `ExtractAtomSetter<T>` | Read-write: extract setter function signature | Writable atom |

See [cross-feature.md](./references/cross-feature.md) for code examples and the "When to Use Which" guide.

## Reference Index

| Reference | Content | When to Read | Search Hints |
|-----------|---------|--------------|--------------|
| [cross-feature.md](./references/cross-feature.md) | 5 golden rules, 3 injection patterns with code, type extraction variants, service access pattern, common mistakes | Cross-feature communication analysis | `## 5 Golden Rules`, `## 3 Component Injection`, `## Type Extraction`, `## Common Mistakes`, `## Service Access` |
| [enforcement.md](./references/enforcement.md) | 6-step enforcement workflow, expanded Rule 5 + Rule 7, blocking vs warning, WHY rationale | Rule violation review, understanding enforcement depth | `## 6-Step Enforcement`, `## Rule 5 Expanded`, `## Rule 7 Expanded`, `## Rules 1–4, 6` |
| [decisions.md](./references/decisions.md) | 8 decision trees: dumb vs smart, state scope, services split, props interface, shared components, splitting, error handling, optimistic updates | Architectural decision-making | `## 1. Dumb vs Smart`, `## 3. State Scope`, `## 7. Error Handling`, `## 8. Optimistic` |
