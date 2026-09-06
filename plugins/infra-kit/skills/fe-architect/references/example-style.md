# Example Style — how long a code example may be

Authoring standard for code examples in `fe-patterns` and `fe-architect`. Applies when writing or
reviewing these skills' reference docs — not to application code.

## The rule

**An example is as long as the idea it teaches. Everything else is noise that competes with the
idea for the reader's attention.**

An agent reading a 40-line block to extract a 4-line point pays for all 40 lines of context and
must infer which 4 matter. Long examples do not teach more thoroughly; they teach less reliably,
because the signal is diluted.

## What the measurement showed

Across both skills: 122 code blocks, median 11 lines — the median is healthy. The problem is
entirely in the tail.

| Symptom | Measured |
|---|---|
| Blocks over 25 lines | 21 |
| Ceremony (imports, blanks, closing braces, interface scaffolding) in `cross-feature.md` | 53% of code lines |
| Same, `enforcement.md` | 51% |
| `cross-feature.md` that is code rather than prose | 54% of the file |
| ❌ vs ✅ markers in `enforcement.md` | 14 vs 9 |

That last row is the biggest single lever: a ❌/✅ pair usually duplicates an entire scaffold twice
to show a one-line difference.

## Budgets

| Context | Budget | Rationale |
|---|---|---|
| Explanatory doc (`cross-feature.md`, `enforcement.md`, `decisions.md`) | **≤ 12 lines**, hard cap 25 | The block teaches one contrast, not a file |
| ❌/✅ pair | **≤ 8 lines per half** | Only the differing lines justify their place |
| Template catalog (`templates.md`) and `assets/` | **No cap** | Here the full file *is* the deliverable — copy-paste fidelity outranks brevity |

The exception is real: do not shorten `templates.md` or the feature template. They exist to be
copied verbatim.

## Five techniques

### 1. Show the delta, not the file

Elide shared scaffold with `// …`. The reader's eye lands on what changed.

```tsx
// ❌ Feature A reaches into Feature B's service
import { userService } from '#root/features/user'
const user = useAtomValue(userService.$currentUser)

// ✅ Page passes it down; Feature A takes a prop
const DashboardContainer = ({ currentUser }: DashboardContainerProps) => // …
```

Six lines carry what `cross-feature.md:419-442` currently spends 22 on.

### 2. One idea per block

If a block teaches two things, it is two blocks. A block showing page orchestration *and* a props
interface *and* a `useEffect` fetch teaches none of them clearly.

### 3. Include an import only when the import is the point

Rule 6 is about which imports are forbidden, so there the import line *is* the payload — keep it.
Everywhere else, `useAtomValue` and `cn` are assumed known.

### 4. Prefer a table when the facts are enumerable

Allowed/forbidden lists, thresholds, and pattern comparisons compress far better as rows than as
commented code. `enforcement.md`'s "Allowed in Dumb Components" table is the model.

### 5. Ask whether it should be code at all — apply this test first

Compression is the second question. The first is **deletion**: strip every identifier the rule does
not actually constrain, and see what survives.

A container rule about guard ordering constrains the **conditions** — `isLoading && !data`, `error`,
empty. It says nothing about `<LoadingSpinner />`, `<EmptyState />` or `<FeatureComponent />`; those
are the application's choices, invented placeholders that no repo file defines. Strip them and four
ordered conditions remain — which is a table, not a code block.

This is the failure mode to watch for: an example that has been *shortened* still teaches
implementation detail, just in fewer lines. Neatly aligned invented components are still invented
components.

**Role names are the exception.** `DashboardContainer` and `NotificationBadge` in a cross-feature
example are not render detail — the rule is *about* two features and the page between them, so it
cannot be stated without naming two participants. Keep a name when it identifies a role the rule
constrains; cut it when it only identifies what appears on screen.

## Worked example

`cross-feature.md:227-267` spends 40 lines to teach one thing: *the chart feature receives filters
as a prop instead of importing the filter service.* Compressed:

```tsx
// app/pages/analytics-page.tsx — the page is the only place both features meet
const activeFilters = useAtomValue(filterService.$activeFilters)
return <><FilterContainer /><ChartContainer filters={activeFilters} /></>

// features/chart/containers/chart-container.tsx — no filterService import anywhere
const ChartContainer = ({ filters }: ChartContainerProps) => // …
```

Five lines, same lesson. The dropped 35 lines — a props interface, a `useEffect`, a JSX tree, three
imports — were all things the reader already knows how to write.

## Review checklist

- [ ] **Should this be code at all?** Strip every identifier the rule does not constrain — if what
      survives is a list of conditions or ordered facts, it is a table
- [ ] No invented component or module name unless it names a role the rule is about
- [ ] Every block ≤ 12 lines, or justified by the template-catalog exception
- [ ] ❌ and ✅ halves differ only in the lines being taught; shared scaffold elided as `// …`
- [ ] No import unless the import itself is the lesson
- [ ] One idea per block
- [ ] Nothing expressible as a table is expressed as commented code
- [ ] Elision uses `// …` consistently, never a bare `...` that could read as spread syntax

## Measuring

Re-run after edits to confirm the tail shrank:

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8");
[...s.matchAll(/```\w*\n([\s\S]*?)```/g)].map(m=>m[1].split("\n").length-1)
.forEach((n,i)=>n>12&&console.log("block",i+1,n+"L"))' <file.md>
```
