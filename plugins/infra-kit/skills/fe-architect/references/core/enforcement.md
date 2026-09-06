# Enforcement — Layers, Workflow & Expanded Rationale

The WHY behind each rule, which layer catches it, and full expansions of the two rules that carry
no mechanical enforcement at all (6 and 7). Condensed definitions and fix recipes are in
[rules.md](./rules.md) — the canonical rule list.

Rule 1's rationale lives with the cross-feature material in the `fe-patterns` skill
([cross-feature.md](../../../fe-patterns/references/cross-feature.md)), since feature independence
is that skill's whole subject.

---

## Enforcement Layers — who catches what

Three layers enforce this architecture. Knowing which one owns a rule tells you where to spend
attention: **do not re-audit by hand what CI already fails on, and never assume CI covers a rule
it does not implement.**

| Layer | Mechanism | Runs |
|-------|-----------|------|
| Lint | The repo's ESLint config | `pnpm run qa` / CI |
| Scripts | `scripts/{validate_feature,analyze_imports,check_structure}.mjs` | On demand — nothing runs them automatically |
| Agent | This document. No tooling exists; if the agent misses it, nothing catches it | Every review |

**"Agent-only" is the important column.** Rule 6 (purity) and Rule 7 have no mechanical
enforcement whatsoever — they are the reason the expanded sections below exist.

### Who owns each rule

| Rule | Name | Violation = | Owned by |
|------|------|-------------|----------|
| 1 | No cross-feature imports | Hidden dependency, breaks feature isolation | Lint + `validate_feature.mjs` + `analyze_imports.mjs` |
| 2 | Service export naming | Ambiguous API, merge conflicts | `validate_feature.mjs` |
| 3 | Atom `$` prefix | Indistinguishable from regular variables | `validate_feature.mjs` |
| 4 | Async write-only `Fx` suffix | Cannot tell sync from async at call site | `validate_feature.mjs` |
| 5 | Object arguments for write-only atoms | Primitive/positional args — brittle call sites, unsafe refactors | `validate_feature.mjs` |
| 6 | Dumb component `className` + `cn()` | Cannot compose styles | **agent-only** |
| 6 | Dumb component purity (no atoms/services) | Impure components untestable, unreusable | **agent-only** |
| 7 | Container state handling | Runtime crashes, poor UX | **agent-only** |

Lint also owns several component conventions next door to these rules — props interface naming and
typing, destructuring layout, file order, one-component-per-file, stories. Before reporting one as a
finding, check whether lint already has it.

### Do not trust a severity written down here

**This document deliberately records no severities and no lint rule names.** They belong to the lint
config, they change there, and a copy kept here goes stale without anyone noticing — which is
exactly what happened once already: a rule moved from `warn` to `error`, this document said `warn`
for two days, and two skills contradicted each other.

Ask the config instead. It answers for the actual file you are looking at, and it is never out of
date:

```bash
pnpm exec eslint --print-config path/to/file.tsx    # every rule and severity in force
pnpm exec eslint path/to/file.tsx                   # what actually fires
```

If a convention matters to your review and `--print-config` reports it `off`, that is your signal:
nobody is checking it but you.

### The gap lint cannot close

**Only `features/` is classified.** Cross-feature import detection keys off a `**/features/*`
pattern, so code living outside a `features/` directory is unclassified and therefore unpoliced.
`analyze_imports.mjs` matches on the path string instead and does not care where the file sits —
which is why it stays worth running even when lint is green.

### Validation Timing

- **During generation:** Check each rule as code is produced. Stop on first blocking violation.
- **After generation:** Run the validation scripts — nothing runs them for you.
- **During review:** Check all rules on the complete changeset. Report all violations at once,
  and separate agent-only findings from ones lint would have caught anyway.

---

## 6-Step Enforcement Workflow

When a violation is detected during code generation or review:

1. **STOP** — halt generation. Do not produce more code that builds on a violation.
2. **Identify** — name the specific rule (1–7) and its tier.
3. **Show code** — quote the exact offending line(s) with the file path:
   ```
   Rule 6 violation in features/user/components/user-card-component.tsx:
     import { useAtomValue } from 'jotai'  ← prohibited in dumb component
   ```
4. **Explain WHY** — not "it's a rule" but what breaks without it. Use the rationale below.
5. **Provide the fix** — the recipe from [rules.md](./rules.md).
6. **Don't proceed** — until it is resolved. If the user insists on continuing unfixed, say what
   the trade-off is, explicitly.

---

## Rule 6 Expanded: Dumb Component Purity

### The Rule

Dumb components (`*-component.tsx`) are pure UI functions: props in, JSX out. They contain ZERO
business logic, state management, or external data access.

### Explicitly Prohibited Imports in Dumb Components

```typescript
// ❌ ALL of these are BLOCKING violations in a *-component.tsx file
import { useAtomValue, useSetAtom, useAtom } from 'jotai'   // state management
import { featureService } from '../services'                // feature services
import { httpClient } from '#root/lib/http-client'          // direct API calls
import { calculateDiscount } from '../services/libs'        // business logic
import { trackEvent } from '../analytics'                   // analytics (side effect)
import { someService } from '#root/features/other-feature'  // cross-feature service
```

### Allowed in Dumb Components

| Import/Hook | Why Allowed |
|-------------|-------------|
| `useState` | UI-only state (dropdown open, tooltip visible, input focus) |
| `useRef` | DOM references (scroll position, input focus, measurements) |
| `useMemo` | Performance optimization of derived JSX/values from props |
| `useCallback` | Stable references for event handlers derived from props |
| `cn()` from `@wl/web-toolkit` | Style composition utility (required by Rule 6) |
| Third-party UI libraries | Headless UI, Radix, etc. — pure UI concerns |
| `React.forwardRef` | DOM ref forwarding |

### What is NOT UI-Only State

The test is not "does it use `useState`" but "does the value describe the screen, or the work".

| `useState` holding… | Verdict | Why |
|---|---|---|
| `isDropdownOpen`, `tooltipPosition` | ✅ dumb | Purely visual; nothing outside the component cares |
| `searchInput` (controlled value) | ✅ dumb | The input's own display state |
| `scrollRef` (`useRef`) | ✅ dumb | DOM handle |
| `isSubmitting` | ❌ smart | A submission is a business process with an outcome |
| `error` | ❌ smart | Errors originate outside the component |
| `data` | ❌ smart | Fetching is an external dependency |

### Violation and Fix

The tell is the prop: a dumb component taking an **id** has to go fetch something. One taking the
**entity** cannot.

```tsx
// ❌ features/user/components/user-card-component.tsx — a dumb component
import { useAtomValue } from 'jotai'                 // ← prohibited in this file
interface UserCardComponentProps { userId: string; className?: string }
// … const user = useAtomValue(userService.$users).find((u) => u.id === userId)
//     both the atom access and the filtering belong in the container

// ✅ same file — takes the resolved entity, nothing else changes
interface UserCardComponentProps { user: User; className?: string }

// ✅ features/user/containers/user-card-container.tsx — the work moves here
const users = useAtomValue(userService.$users)
const user = users.find((u) => u.id === userId)
// … return <UserCardComponent user={user} />
```

### WHY: Rationale for Dumb Component Purity

1. **Testability** — Dumb components test with simple prop objects. No Jotai provider, no mock services, no async setup. Tests run fast and never flake.
2. **Reusability** — A pure dumb component works in any context: different features, Storybook, design system docs. Coupled components only work where their services exist.
3. **Predictability** — Given the same props, a dumb component always renders the same output. No hidden state changes, no surprise re-renders from atom subscriptions.
4. **Storybook compatibility** — Stories define props directly. If a component needs atoms or services, every story requires complex decorators and mock providers.
5. **Performance isolation** — Atom subscriptions cause re-renders. Keeping subscriptions in containers means dumb components only re-render when their props actually change.

---

## Rule 7 Expanded: Container State Handling

### The Rule

Smart components (containers) must handle all possible states before rendering content: loading,
error, empty, and content.

### Loading: First Fetch Only

```tsx
// ❌ fires on every refetch, wiping content the user was already reading
if (isLoading) return <LoadingSpinner />

// ✅ the full loading branch only when there is nothing on screen yet
if (isLoading && !data) return <LoadingSpinner />
```

**Why:** Replacing visible content with a spinner during a refetch (pull-to-refresh, polling,
re-navigation) is jarring and makes the app feel slow. A refetch should leave the stale data on
screen and signal itself some subtler way — an inline indicator, a dimmed state, whatever the
design system offers. That choice is the application's; only the `&& !data` half of the guard is
this rule.

### Minimum Required States

Four guards, in this order, before any content renders. The **condition** is the rule; what each
branch renders is the application's business.

| # | Guard condition | Why it sits here |
|---|---|---|
| 1 | `isLoading && !data` | Runs first so error/empty cannot fire during the initial fetch, when `error` is null but `data` is null too |
| 2 | `error` | Once loading has finished, a failure wins regardless of what `data` holds |
| 3 | `!data \|\| data.length === 0` | Loaded successfully but with nothing to show — a distinct state from failure, and a distinct message to the user |
| 4 | *(none — content)* | Every edge case is now excluded, so TypeScript narrows `data` to non-null; no `!` assertion or optional chaining needed |

Order is not stylistic. Swap 1 and 2 and a slow first fetch renders an error state; swap 2 and 3
and a failed request shows "no items found".

### What the violation looks like

```tsx
// ❌ features/projects/containers/project-list-container.tsx
const projects = useAtomValue(projectService.$projects)
return <ProjectListComponent projects={projects} />
// blank screen while fetching · nothing at all on failure · broken layout when
// the array is empty · and a crash whenever projects is still null
```

The fix is the four guards above, applied in order before this `return` — that ordering is the
whole rule, so it is not repeated here.

### WHY: Rationale for Container State Handling

1. **Crash prevention** — Accessing properties on `null`/`undefined` data is the most common runtime error in React apps. Guard clauses eliminate this class of bugs entirely.
2. **User experience** — Every state tells the user what's happening. A blank screen is worse than a loading spinner; a loading spinner is worse than an error message with a retry button.
3. **TypeScript narrowing** — Guard clauses progressively narrow the type. After `if (!data) return ...`, TypeScript knows `data` is non-null in the content branch — eliminating the need for non-null assertions or optional chaining.
4. **Debugging** — When something goes wrong, a visible error state with details is infinitely more useful than a blank screen or a console error buried in noise.

---

## Rules 2–6: WHY Rationale

Fix recipes are in [rules.md](./rules.md). Rule 1's rationale is in the `fe-patterns` skill.

### Rule 2: Service Export Naming (`[featureName]Service`)

- **Disambiguation** — `service.$data` is meaningless in a page that imports 5 features; `userProfileService.$data` is clear
- **Grep-ability** — Searching for `userProfileService` finds all usages instantly; `service` matches everything
- **Merge conflict prevention** — Generic names like `service` cause conflicts when features are composed in the same page file

### Rule 3: Atom `$` Prefix

- **Visual scanning** — In a file with 20 imports, `$userData` immediately reads as "reactive state" while `userData` could be anything
- **Accidental mutation prevention** — The `$` signals "subscribe to this, don't mutate it" — a cognitive guardrail
- **Convention alignment** — Consistent with observable/signal conventions in other state libraries (MobX, Solid, Svelte stores)

### Rule 4: Async Write-Only `Fx` Suffix

- **Async awareness** — `getUserFx` tells the developer at the call site that this is async (needs error handling, may be slow, returns a promise)
- **Sync vs async distinction** — `resetDataAtom` (sync, instant) vs `resetDataFx` (async, may fail) require different handling patterns
- **Error handling obligation** — The `Fx` suffix is a reminder that the call may fail and the error must be handled somewhere

### Rule 5: Object Arguments for Write-Only Atoms

- **Named parameters** — `updateUserFx({ userId, name })` is self-documenting at the call site; positional primitives (`updateUserFx(id, name)`) invite argument-order bugs
- **Safe evolution** — Adding a field to a `{AtomName}Args` interface is non-breaking; changing a positional signature silently breaks every call site
- **Type extraction** — `ExtractAtomActionArgs<typeof updateUserFx>` yields a usable named type for cross-feature props only when the atom takes a single typed object

### Rule 6: Dumb Component `className` + `cn()`

- **Composability** — Without `className`, a parent cannot adjust spacing, sizing, or layout of a child component without wrapper divs
- **Design system alignment** — `cn()` merges Tailwind classes correctly (later classes override earlier ones), preventing specificity bugs
- **Consistent API** — Every dumb component has the same escape hatch for styling, reducing the "how do I customize this?" question to zero
