---
name: fe-architect
version: 3.0.0
description: Guide developers through feature-based frontend architecture using React, TypeScript, Jotai, and Tailwind CSS. Activate for creating new features, restructuring code into features, modifying feature services/containers/state, or making architectural decisions about component boundaries and state patterns. Do NOT activate for trivial CSS tweaks, console.log additions, or simple one-line fixes.
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

**Tech Stack:** React + TypeScript + Tailwind CSS + Jotai + Fetch-based `httpClient` from `#root/lib/http-client` + `ServerError` (status 570) + `query-string` for URLs + Vitest + React Testing Library + Storybook

## Project Discovery (ALWAYS DO FIRST)

Before creating or modifying features, discover the actual project structure:

1. **Find existing features directories:** Search for `features/` folders across the monorepo (`apps/`, `packages/`, project root)
2. **Identify the target app:** Determine which app/package the user is working in
3. **Adapt paths accordingly:** Use the discovered path (e.g., `apps/client/src/features/`) instead of assuming `features/` at root
4. **Check existing patterns:** Look at 1-2 existing features in the project to match local conventions

## Enforcement Rules (BLOCKING)

All 7 rules are mandatory. Violation = STOP and fix. See [rules.md](./references/core/rules.md) for detailed examples and fix recipes.

1. **No cross-feature imports** — Features never import from other features (except `import type`). Fix: pass data via props at page level.
2. **Service export naming** — Must follow `[featureName]Service` pattern. Fix: rename to camelCase feature name + "Service".
3. **Atom `$` prefix** — All state/derived atoms must have `$` prefix. Fix: add `$` prefix.
4. **Async write-only `Fx` suffix** — Async write-only atoms must have `Fx` suffix. Fix: add `Fx` suffix.
5. **Object arguments for write-only atoms** — Must use object with typed interface, not primitives. Fix: create `{AtomName}Args` interface.
6. **Dumb component `className` + `cn()`** — All dumb components must accept `className?` prop and use `cn()` from `#root/lib/utils`. Fix: add prop and wrap root element.
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
3. Copy feature template and replace placeholders:
   ```bash
   cp -r .claude/skills/fe-architect/assets/feature-template [target-features-dir]/[feature-name]
   ```
   See [template README](./assets/feature-template/README.md) for placeholder conventions.
4. Implement bottom-up: **Types → Dumb Components → Services → Smart Components → index.ts**
5. Use `services.ts` if < 3 endpoints AND < 250 lines; use `services/` folder otherwise
6. Validate against [enforcement rules](#enforcement-rules-blocking)

For implementation details: [templates.md](./references/implementation/templates.md) | [api-layer.md](./references/implementation/api-layer.md) | [state-management.md](./references/implementation/state-management.md)

### MODIFY: Existing Features

1. Scan feature for rule violations → fix first
2. Determine change type (add component, add API, modify logic)
3. Follow CREATE patterns for new parts; maintain separation of concerns for modifications
4. Update `index.ts` if public API changes
5. Validate against enforcement rules

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
├── services.ts           # Simple: < 3 endpoints, < 250 lines
├── services/             # Complex: 3+ endpoints or > 250 lines
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

For type extraction across features, use `ExtractedAtomType`, `ExtractWriteOnlyAtomArgs`, `ExtractAtomSetter` from `@pkg/web-toolkit`.

See [rules.md](./references/core/rules.md) for cross-feature details.

## Reference Index

| Reference | Content | When to Read |
|---|---|---|
| [core/rules.md](./references/core/rules.md) | 7 enforcement rules with examples and fix recipes, cross-feature patterns, naming conventions | Rule violations, cross-feature communication |
| [implementation/templates.md](./references/implementation/templates.md) | Complete code templates for all file types | Creating new files |
| [implementation/api-layer.md](./references/implementation/api-layer.md) | httpClient patterns, error handling, ServerError, Sentry, caching | API integration |
| [implementation/state-management.md](./references/implementation/state-management.md) | Jotai atom patterns, derived state, async operations | State management questions |
| [patterns/cookbook.md](./references/patterns/cookbook.md) | CRUD, lists, forms, async, and advanced patterns | Implementation recipes |
| [testing/testing.md](./references/testing/testing.md) | Testing + Storybook patterns | Writing tests and stories |
| [maintenance/migration.md](./references/maintenance/migration.md) | Refactoring scenarios and migration strategies | Converting legacy code |
| [maintenance/analytics.md](./references/maintenance/analytics.md) | Analytics tracking (OPTIONAL, client projects only) | Adding analytics |

## Validation Tools

After implementing or modifying a feature, run:

```bash
# Complete feature validation
node .claude/skills/fe-architect/scripts/validate_feature.mjs [features-path]/[feature-name]

# Cross-feature import analysis
node .claude/skills/fe-architect/scripts/analyze_imports.mjs [features-path]/[feature-name]

# Directory structure check
node .claude/skills/fe-architect/scripts/check_structure.mjs [features-path]/[feature-name]
```

When violations are detected, STOP and fix before proceeding.
