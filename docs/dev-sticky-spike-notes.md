# Spike S — capturing the frontend child for a sticky footer during UI sessions

Gates whether **Phase 2** of the persistent-footer plan (`.omc/plans/dev-sticky-ui-plan.md`) is viable:
can `infra-kit dev` pipe the frontend `turbo run dev` child, own the terminal frame, and keep a live
footer pinned during a **UI** session? (Backend-only sessions already ship it — Phase 0+1.)

## Verdict: **NO-GO** for the general case. Phase 2 is out of scope.

> **SUPERSEDED — read this first.** The NO-GO below applies only to the approach this spike
> tested: **piping** the frontend child and reconstructing the frame from its output. That
> approach is still dead, and for the reasons given.
>
> A UI-session sticky footer **does now ship**, by a different mechanism: a terminal
> scroll region (DECSTBM) reserves the footer rows and lets the child scroll above it,
> untouched — so nothing needs to capture or parse the child's output. See
> `src/dev/scroll-region.ts` and `src/tui/dev-ui/scroll-region-dev-ui.ts`.
>
> Do not cite this document as evidence that UI-session footers are impossible. Cite it as
> evidence that *capturing the child* is the wrong way to get one.

The backend-only persistent footer (Phase 0 + Phase 1) is the correct deliverable **for the piping
approach**. Capturing vite/vike/astro output to keep the footer live during UI sessions is **not
viable** without violating a core infra-kit principle. Details per gate below.

## Evidence

### S-a — does `--clearScreen false` reach the framework through `turbo run dev` + the package `dev` script? → **NO (and not universally expressible)**
Frontends are launched as `pnpm exec turbo run dev --filter=<pkg> …` (`ui-dev.ts:57-68`). The consumer
`dev` scripts observed across the reachable monorepos are **heterogeneous and framework-specific**:

| framework | observed `dev` script |
|---|---|
| vite | `"vite"`, `"vite --open"`, `"vite dev --port 3000"` |
| vike | `"pnpm exec vike dev"`, `"vike dev"` |
| astro | `"astro dev"` |
| docusaurus | `"docusaurus start --port=4444"` |

There is **no single flag** that suppresses screen-clearing across all of them (`vite --clearScreen false`
is vite-only; astro/docusaurus differ or don't clear the same way). Passing one universal flag through
`turbo run dev -- …` cannot work, and even where pnpm's trailing-arg append would forward it, the flag
name is per-framework.

### S-b — turbo streaming cleanliness → **REQUIRES turbo TUI disable** (turbo `2.10.3` in consumers)
turbo 2.x renders its own interactive TUI/prefixed multiplex; clean per-line capture would require
`TURBO_UI=0` / `--log-order=stream`. Achievable, but only addresses turbo — not the framework layer (S-a).

### S-c — `FORCE_COLOR=1` survival → plausible but unverified at runtime
chalk-based color generally survives `FORCE_COLOR=1` through the turbo→framework hop, but this was not
runtime-verified because S-a already blocks the approach.

### S-d — child losing `isTTY` when piped → **degrades framework UX**
Piping flips the child's `process.stdout.isTTY` to false, which in vite/vike disables the interactive
shortcut menu (`r` restart, `u` show URLs, `o` open) and can suppress URL reprints — a real UX regression
for the exact sessions the feature targets.

## The decisive finding (beyond the four gates)

`ui-dev.ts:12-13` states infra-kit's governing principle explicitly:

> "infra-kit treats UIs opaquely: it runs their `dev` script (vite/vike/astro/…) and **never encodes
> per-framework knowledge**."

Option A (pipe + per-framework clearScreen/arg flags + framework-specific URL parsing for the footer)
would **require encoding exactly that per-framework knowledge** — a direct violation. Combined with S-a
(no universal flag), S-b (turbo TUI), and S-d (lost interactive UX), the honest conclusion is that
capturing the frontend to pin a footer during UI sessions is the wrong trade for this codebase.

## Consequence

- **Phase 2 (US-005): out of scope.** No `ui-dev.ts` stdio change is made.
- **Shipped:** the mutability-split header + persistent live footer for **backend-only / `--no-ui`**
  sessions (Phase 0 + Phase 1), behind `INFRA_KIT_DEV_STICKY` / `options.sticky`, TTY-only.
- UI sessions keep today's behavior: header committed at ready, then inherited framework output streams
  below (unchanged) — chosen at `ready()` via `summary.uiRefs.length > 0`.
- If a future need justifies it, the only principled path is per-framework adapters (opt-in), which is a
  separate, larger proposal — not this feature.

---

## Postscript — the NO-GO above is SUPERSEDED. UI-session sticky shipped via a scroll region.

Everything above is still true **of the approach it evaluated**, which was: *pipe the frontend child's
stdout through infra-kit*. Piping is what forces per-framework `--clearScreen` flags (S-a), turbo TUI
suppression (S-b), and the loss of the child's `isTTY` and its interactive shortcuts (S-d). That verdict
stands, and we did not do it.

**The spike never considered a terminal scroll region (DECSTBM, `ESC [ top ; bottom r`).** A scroll
region is set on the *terminal*, not on the child: it confines all scrolling — ours and the inherited
child's — to the rows above the footer. The child keeps `stdio: 'inherit'`, keeps its `isTTY`, keeps its
shortcut menu, and needs no flags. Every blocker S-a…S-d is about piping, so none of them apply.

**Shipped:**
- `src/dev/scroll-region.ts` — pure ANSI builders (`installRegion`, `paintFooter`, …), no I/O.
- `src/tui/dev-ui/scroll-region-dev-ui.ts` — `ScrollRegionDevUi implements DevUi`. No Ink: Ink's
  reconciler cannot share a TTY with a child writing raw bytes. Handles `SIGWINCH`, resets the region
  on `dispose`, and degrades to a plain print on a non-TTY or a terminal too short for the footer.
- `PersistentInkDevUi.ready()` unmounts Ink and hands off to it for UI sessions.
- `ui-dev.ts` stdio is **unchanged** (`inherit`), so the governing "never encode per-framework
  knowledge" principle is intact.

**Two corrections to the text above, both load-bearing:**
1. `summary.uiRefs.length > 0` is **no longer a valid UI-session test**. Since portless Layer B landed,
   a UI whose alias registers becomes an `EndpointRow`, not a `UiRef` — so `uiRefs` is *empty* for a UI
   session, and any live-region UI would have scribbled straight into vite's output. `ReadySummary` now
   carries an explicit `hasUiChild: boolean`, and that is what both UIs branch on.
2. `stdout.rows` on a TTY can be `0`, not just absent — a pty allocated without a window size
   (`script(1)`, some CI runners, a terminal before its first `SIGWINCH`) reports `isTTY: true` with
   `rows: 0`. A `??` fallback passes that `0` through and silently disables the footer. Guard with a
   positive-number check, not nullish coalescing.

**Verified in a real pty** (`script(1)`, 40×120): region installed as `ESC[1;32r`, an 8-line footer
painted at rows 33–40, cursor save/restore balanced, child output scrolling above it, `refresh()`
repainting health in place, and `dispose()` emitting `ESC[r` + `ESC[?25h`. Unit tests alone would not
have caught the `rows: 0` defect — it only appears under a real pty.
