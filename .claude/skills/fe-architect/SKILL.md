---
name: fe-architect
version: 3.0.0
description: Build and review the inside of a feature — React, TypeScript, Jotai, Tailwind. Activate for creating or scaffolding features, restructuring code into features, modifying services/containers/state, enforcing the naming rules ($ prefix, Fx suffix, service export names), dumb vs smart component boundaries, container loading/error/empty guards, state scope, splitting, error handling, and optimistic updates. Use fe-patterns instead when the question crosses a feature boundary. Do NOT activate for trivial CSS tweaks, console.log additions, or simple one-line fixes.
tags: [react, typescript, jotai, tailwind, architecture, features, frontend, state-management]
author: Feature Architecture Team
license: MIT
---

# Frontend Feature Architecture Skill

## Core Principles

- Everything is a self-contained feature
- Separation: Dumb Components (UI) / Smart Components (Logic) / Services (State)
- Features NEVER import from other features (compose at page level only)
- Strict naming: `$` prefix for atoms, `Fx` suffix for async write-only atoms
- All write-only atoms use object arguments with typed interface

**Tech Stack:** React + TypeScript + Tailwind CSS + Jotai + `@wl/web-toolkit` (`cn`, `HttpClient`, `ServerError` at status 570, atom type-extraction utilities) + an app-level `httpClient` singleton at `#root/lib/http-client` built from `HttpClient` + `query-string` for URLs + Vitest + React Testing Library + Storybook

## Project Discovery (ALWAYS DO FIRST)

Before creating or modifying features, discover the actual project structure:

1. **Find existing features directories:** Search for `features/` folders across the monorepo (`apps/`, `packages/`, project root)
2. **Identify the target app:** Determine which app/package the user is working in
3. **Adapt paths accordingly:** Use the discovered path (e.g., `apps/client/src/features/`) instead of assuming `features/` at root
4. **Check existing patterns:** Look at 1-2 existing features in the project to match local conventions
5. **Verify the stack actually resolves:** The templates import `cn`, `ServerError`, and the type-extraction
   utilities from `@wl/web-toolkit`, and `httpClient` from the app-owned `#root/lib/http-client` singleton.
   Confirm each one exists in the target app before generating code against it — report what you found and ask
   which local equivalent to use if any is missing. Do not emit imports for modules you have not confirmed.

## Enforcement Rules (BLOCKING)

All 7 rules are mandatory. Violation = STOP and fix. See [rules.md](./references/core/rules.md) for detailed examples and fix recipes, and [enforcement.md](./references/core/enforcement.md) for which layer catches each rule, the expanded Rules 6–7, and the WHY behind Rules 2–6.

Rule 1 is the exception: feature independence, the three injection patterns, and cross-feature type extraction belong to the `fe-patterns` skill. Reach for it whenever the question crosses a feature boundary; everything inside one feature is this skill.

1. **No cross-feature imports** — Features never import from other features (except `import type`). Fix: pass data via props at page level.
2. **Service export naming** — Must follow `[featureName]Service` pattern. Fix: rename to camelCase feature name + "Service".
3. **Atom `$` prefix** — All state/derived atoms must have `$` prefix. Fix: add `$` prefix.
4. **Async write-only `Fx` suffix** — Async write-only atoms must have `Fx` suffix; sync write-only atoms use the `Atom` suffix. Fix: add the suffix.
5. **Object arguments for write-only atoms** — Must use object with typed interface, not primitives. Fix: create `{AtomName}Args` interface.
6. **Dumb component `className` + `cn()`** — All dumb components must accept `className?` prop and use `cn()` from `@wl/web-toolkit`. Fix: add prop and wrap root element.
7. **Container state handling** — Smart components must handle loading, error, and empty states. Fix: add guards before rendering content.

## Workflow

### Infer → Summarize → Confirm

Instead of asking many questions upfront, **infer from context**:

1. **Analyze the request** — Determine feature name, whether UI/API/state is needed, and complexity
2. **Present a brief plan:**
   > "I'll create feature `user-profile` in `apps/client/src/features/` with:
   > - Dumb component + container (UI needed)
   > - Services folder (3 API endpoints → complex)
   > - Types, tests, stories
   > Using the feature template."
3. **Only ask when genuinely ambiguous** — e.g., unclear feature name, unclear whether simple or complex services

### CREATE: New Features

1. Run [Project Discovery](#project-discovery-always-do-first)
2. Infer requirements → present plan → confirm
3. Scaffold the feature — this substitutes every placeholder, renames the files, picks one services
   variant, and runs both validators. **Non-zero exit = STOP and fix before continuing.**
   ```bash
   node .claude/skills/fe-architect/scripts/scaffold_feature.mjs [target-features-dir] [feature-name]
   # add --complex for the services/ folder variant (3+ endpoints or > 250 lines)
   ```
   See [template README](./assets/template-README.md) for the template layout, the placeholder
   table, and the manual `cp -r` fallback.
4. Implement bottom-up: **Types → Dumb Components → Services → Smart Components → index.ts**
5. Use `services.ts` if < 3 endpoints AND < 250 lines; use `services/` folder otherwise — pass
   `--complex` at step 3 to get the folder variant. A feature must never ship both.
6. Validate against [enforcement rules](#enforcement-rules-blocking) by re-running the
   [validation tools](#validation-tools); **non-zero exit = STOP**

For implementation details: [templates.md](./references/implementation/templates.md) | [api-layer.md](./references/implementation/api-layer.md) | [state-management.md](./references/implementation/state-management.md)

### MODIFY: Existing Features

1. Scan feature for rule violations → fix first
2. Determine change type (add component, add API, modify logic)
3. Follow CREATE patterns for new parts; maintain separation of concerns for modifications
4. Update `index.ts` if public API changes
5. Validate against enforcement rules — run the [validation tools](#validation-tools);
   **non-zero exit = STOP**

### REFACTOR: Legacy Code → Features

1. Identify scenario: standalone component → feature, large feature → split, services.ts → services/ folder
2. Create migration plan: map old → new structure
3. Execute incrementally (types first, then components, then services)
4. Verify no behavior changes

For detailed refactoring patterns: [migration.md](./references/maintenance/migration.md)

## Feature Structure

```
features/[feature-name]/
├── index.ts              # Public API (ALWAYS required)
├── types.ts              # TypeScript types (ALWAYS required)
├── __tests__/            # All tests (components + containers)
│   ├── [name]-component.test.tsx
│   └── [name]-container.test.tsx
├── __stories__/          # Storybook stories (dumb components only)
│   └── [name]-component.stories.tsx
├── components/           # Dumb components (if UI needed)
│   └── [name]-component.tsx
├── containers/           # Smart components (if logic needed)
│   └── [name]-container.tsx
├── services.ts           # Simple: < 3 endpoints, < 250 lines   ─┐ exactly
├── services/             # Complex: 3+ endpoints or > 250 lines ─┘ one of these
│   ├── main.ts           # Atoms + orchestration (re-exports all)
│   ├── api.ts            # API calls (pure functions)
│   └── libs.ts           # Pure business logic
└── analytics.ts          # Optional: client-facing projects only
```

### Public API Pattern (`index.ts`)

```typescript
export { FeatureNameContainer } from './containers/feature-name-container'
export * as featureNameService from './services'  // [featureName]Service
export type { FeatureNameData } from './types'
```

### Cross-Feature Communication

Features communicate only at the page level. Three patterns:
- **Element pattern:** `<Container icon={<OtherFeatureIcon />} />` — simple slots
- **Component pattern:** `<Container SidebarComponent={OtherFeature} />` — parent controls props
- **Render function:** `<Container renderSection={(props) => <OtherFeature {...props} />} />` — full control

For type extraction across features, use `ExtractedAtomType`, `ExtractAtomActionArgs`, `ExtractAtomSetter` from `@wl/web-toolkit`.

See [rules.md](./references/core/rules.md) for cross-feature details.

## Reference Index

Grep for the search hints rather than reading a whole reference — `cookbook.md` alone is 400+ lines.

| Reference | Content | When to Read | Search Hints |
|---|---|---|---|
| [core/rules.md](./references/core/rules.md) | 7 enforcement rules with examples and fix recipes, cross-feature patterns, naming conventions | Rule violations, cross-feature communication | `## 1. No Cross-Feature`, `## 5. Object Arguments`, `## 6. Dumb Component`, `## Naming Conventions` |
| [core/enforcement.md](./references/core/enforcement.md) | Which layer owns which rule (lint / script / agent-only), how to ask the config what is live, 6-step violation workflow, Rules 6–7 expanded, WHY for Rules 2–6 | Reviewing a feature, deciding whether CI already covers something | `## Enforcement Layers`, `## Who owns each rule`, `## Do not trust a severity`, `## The gap lint cannot close`, `## Rule 6 Expanded`, `## Rule 7 Expanded`, `## Rules 2–6` |
| [patterns/decisions.md](./references/patterns/decisions.md) | 7 intra-feature decision trees: dumb vs smart, services split, state scope, props interface, component splitting, error strategy, optimistic updates | Architectural decision-making inside a feature | `## 1. Dumb vs Smart`, `## 2. services.ts`, `## 3. State Scope`, `## 6. Error Handling`, `## 7. Optimistic` |
| [example-style.md](./references/example-style.md) | Length budgets for code examples in these docs, five compression techniques, review checklist | Writing or reviewing this skill's reference docs | `## The rule`, `## Budgets`, `## Five techniques`, `## Review checklist` |
| [implementation/templates.md](./references/implementation/templates.md) | Complete code templates for all file types | Creating new files | `## Types Template`, `## Dumb Component Template`, `## Smart Component Template`, `## Services Template`, `## Public API Template`, `## Test Templates` |
| [implementation/api-layer.md](./references/implementation/api-layer.md) | httpClient patterns, error handling, ServerError, Sentry, caching | API integration | `## HTTP Client`, `## Complete Effect Pattern`, `## Error Handling`, `## Query Parameters`, `## Sentry Integration` |
| [implementation/state-management.md](./references/implementation/state-management.md) | Jotai atom patterns, derived state, async operations | State management questions | `## Atom Types`, `## Basic Patterns`, `## Using Atoms in Components`, `## Atoms vs Local State`, `## Optimistic Updates` |
| [patterns/cookbook.md](./references/patterns/cookbook.md) | CRUD, lists, forms, async, and advanced patterns | Implementation recipes | `## CRUD Pattern`, `## List with Search`, `## Form with Validation`, `## Multi-Step Wizard`, `## Optimistic UI`, `## Infinite Scroll`, `## Authentication Flow` |
| [testing/testing.md](./references/testing/testing.md) | Testing + Storybook patterns | Writing tests and stories | `## Dumb Component Tests`, `## Smart Component Tests`, `## Testing Atoms Directly`, `## Mock Patterns`, `## Storybook` |
| [maintenance/migration.md](./references/maintenance/migration.md) | Refactoring scenarios and migration strategies | Converting legacy code | `## Scenario 1`, `## Scenario 2`, `## Scenario 3`, `## Common Pitfalls` |
| [maintenance/analytics.md](./references/maintenance/analytics.md) | Analytics tracking (OPTIONAL, client projects only) | Adding analytics | `## When to Add Analytics`, `## Event Naming Conventions`, `## Feature Analytics File` |

## Validation Tools

Scaffolding a new feature (see [CREATE](#create-new-features)) runs the first and third of these for
you. Run them yourself after **any** hand edit to a feature:

```bash
# Complete feature validation
node .claude/skills/fe-architect/scripts/validate_feature.mjs [features-path]/[feature-name]

# Cross-feature import analysis (pass the features parent directory)
node .claude/skills/fe-architect/scripts/analyze_imports.mjs [features-path]

# Directory structure check
node .claude/skills/fe-architect/scripts/check_structure.mjs [features-path]/[feature-name]
```

Each script **exits non-zero** when it finds an error. A non-zero exit means STOP and fix before
proceeding — errors are blocking, warnings are advisory.

The scripts are themselves covered by `pnpm run test:claude`
(`.claude/skills/fe-architect/__tests__/`). If you change one, run that suite — nothing else will.

### What these scripts deliberately do NOT check

The repo's ESLint config already owns a set of component conventions, so the scripts stay out of its
way. Do not re-add checks for:

- Dumb components have stories
- Props typed by reference rather than inline, and named `{Component}Props`
- Blank line after `const { … } = props`, and destructuring layout
- File order: imports → `*Props` → component
- One component per file

**Do not assume every item above is live.** Some are shipped but switched off, and which ones
changes over time — this section used to list two of them as enforced when they were not. Ask the
config for the file you are actually working on:

```bash
pnpm exec eslint --print-config path/to/file.tsx
```

Anything it reports as `off` is a convention **nothing** checks, so the agent must.

Cross-feature imports are the one overlap the scripts **keep**. Lint covers them, including aliased
`#root/features/…` forms, but only inside a `features/` directory — code outside one is never
classified, and that is the gap `analyze_imports.mjs` exists to fill. Layer ownership for all 7
rules is in
[core/enforcement.md](./references/core/enforcement.md); the cross-feature patterns themselves
live in the `fe-patterns` skill.
