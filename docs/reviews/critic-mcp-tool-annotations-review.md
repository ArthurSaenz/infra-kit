# Critic review — `docs/mcp-tool-annotations-plan.md`

**Verdict: ITERATE**

Reviewer: Critic (read-only). Complements the Architect review; its 14 items are referenced by number,
not repeated. Paths relative to `apps/infra-kit/cli` unless prefixed `docs/`.

---

## Q1 (the headline) — does S1 satisfy the user's ask? **No. Reject S1's `destructiveHint` half.**

The Architect's S1 ships **no explicit `destructiveHint` anywhere** and leans on the spec default of
`true`. That is a technicality that fails the ask, and I can show it is a technicality rather than a
judgement call.

**The default is prose in the spec document. Nothing in the shipped implementation materializes it.**

- `node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs:1138-1144` (2025-era chunk) and
  `:2698` (2026-era chunk) both define:
  ```js
  const ToolAnnotationsSchema$1 = z.object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional()
  });
  ```
  `.optional()` with **no `.default()`**. A client parsing `tools/list` with the reference schema gets
  an object on which the key is **absent** — `annotations.destructiveHint === undefined`.
- `grep -rn destructiveHint node_modules/@modelcontextprotocol/` returns **zero** hits outside those
  two schema definitions. No reader, no default-application, no helper. Any host wanting the spec
  default must hand-write `annotations?.destructiveHint ?? true`; the far more natural
  `annotations?.destructiveHint === true` yields `false`.

So under S1, the `tools/list` bytes describing destructiveness are **identical before and after the
change**. The user's sentence is *"Зараз хост не бачить деструктивності тула на рівні протоколу"* — the
host does not *see* it. S1's end state is a host that still sees no `destructiveHint` field on any
tool. It satisfies a spec lawyer and fails the person who filed the ticket.

**S1 is also internally inconsistent.** It keeps `openWorldHint` explicit — including `true` on the 12
open-world tools, where `true` **is** the spec default. If "omitted means default, so don't send it" is
the principle, S1 does not apply it to its own second hint. The plan's instinct (send the value) is
right; S1 breaks it in exactly one place, and that place is the ask.

**What to do instead — and it is strictly better than both the plan and S1.** Derive with no opt-out
array at all:

```
destructiveHint = entry.mutating ? true : undefined
```

- Transmits the key explicitly on all 12 mutating tools ⇒ the ask is met literally.
- Deletes `ADDITIVE_ONLY` entirely ⇒ the Architect's strongest structural objection (a hand-typed
  per-tool safety override, the artifact §4 condemns Option B for) is answered *better* than by S1,
  which deletes the array by deleting the data.
- Resolves E2 (`env-load`) and the `worktrees-add` question mechanically. `worktrees-add` reads
  destructive when it is additive: a one-tool over-claim, which is precisely what **P4** endorses.
- Kills T4's tautological half and T5's first half (both become theorems), leaving a smaller, more
  honest test set.

Adopt this in place of Architect item 3 and item 5's S1 branch.

---

## Findings, by severity

### C1 — CRITICAL. S1 fails the ask; see Q1. Evidence: SDK schema `src-CX2iR2pK.mjs:1138-1144`, `:2698`; zero non-schema `destructiveHint` references in `node_modules/@modelcontextprotocol/`.

### C2 — HIGH. P4 is stated and then not applied. Three violations, all at decision points.

P4 (`docs/mcp-tool-annotations-plan.md:50-53`): *"Where a hint is uncertain, keep the spec default …
Under-claiming risk is the dangerous error."* Spec defaults: `destructiveHint` **true**,
`readOnlyHint` **false**, `idempotentHint` **false**, `openWorldHint` **true**.

| Assignment | Spec default | Direction | P4? |
|---|---|---|---|
| `ADDITIVE_ONLY` ⇒ `destructiveHint: false` ×2 (`:216`) | `true` | under-claims risk | **violates** |
| `reopen` `readOnlyHint: true` (`:182`) | `false` | under-claims risk | **violates** |
| `idempotentHint: true` ×5 (`:201,202,211,212,213`) | `false` | over-claims (see C3) | **violates** |
| `release-create` `destructiveHint: true` (`:196`) | `true` | conservative | complies — and is the *only* place P4 is cited |

P4 and `ADDITIVE_ONLY` cannot both be right: the array exists solely to produce the under-claim P4
calls dangerous. Either apply P4 mechanically (⇒ my C1 derivation, ⇒ `reopen` is not read-only) or
delete P4 as a principle. As written it is decoration invoked once, and the one time it is invoked it
is invoked for the assignment that needed it least.

### C3 — HIGH. `idempotentHint` is the one hint where over-claiming is *not* merely noisy.

P4's *"over-claiming is merely noisy"* is true for `destructiveHint` and `openWorldHint` — both make a
host warn more. It is **false** for `idempotentHint`, whose entire purpose is to license a host to
**retry**. `worktrees-sync` and `release-desc-edit` are declared `idempotent: true` (`:211,213`) and
both write to GitHub/Jira; `env-clear` is declared `true` while its own description says it **errors**
on a second call (`env-clear.ts:127`, Architect item 13). An auto-retrying host is the failure mode,
and it is the only hint in this plan that can cause a write the user did not ask for.

I therefore reach the Architect's "drop `idempotentHint`" conclusion by a different and stronger route:
not "the judgements are contestable" but "the direction of error is dangerous and P4 gives no cover."
Drop it. If it returns later, it needs a per-tool argument that retrying is safe, not that it converges.

### C4 — HIGH. S3 is not implementable as specified. It is red on 2 of 11 closed-world tools on day one.

The Architect's S3 (assert that every `openWorld: false` tool's import set contains no
`src/integrations/{gh,jira,doppler,aws}` module) produces immediate false positives:

- `src/commands/env-list/env-list.ts:4-5` imports `getDopplerProject` and `INFRA_KIT_ENV_TOKEN_VAR`
  from `src/integrations/doppler/*` — yet the Architect's own confirmation table declares `env-list`
  correctly `openWorld: false`. It is correct: `src/integrations/doppler/doppler-project.ts:23-27`
  shows `getDopplerProject` reads `getInfraKitConfig()` and returns `envManagement.config.name`. **No
  network call.**
- `src/commands/worktrees-remove/worktrees-remove.ts:3` statically imports `getReleasePRsWithInfo` from
  `src/integrations/gh` — and the Architect's E3 concludes `openWorld: false` is correct today.

So S3 as written fails two tools it simultaneously certifies as correct, forcing an exception list —
reintroducing exactly the hand-maintained override S1 was proposed to delete. The granularity is wrong:
the discriminator is **which symbol is called on which path**, not which module is imported.
`src/commands/env-token-list/env-token-list.ts:5` imports the local helper (`getDopplerProject`) and
the network probe (`probeEnvToken`) from the *same barrel*, so even a symbol-level check must then
reason about reachability. Transitive closure is worse still — every command reaches `getInfraKitConfig`.

**Recommendation (choose one, on the record):**
- **(a) Preferred — derive `openWorldHint` from the import graph instead of verifying a declared table.**
  `openWorldHint = true` iff the command module imports any `src/integrations/{gh,jira,doppler,aws}`
  symbol. Drift-proof, conservative (spec default is `true`), and collapses `MCP_TOOL_PRESENTATION` to
  `{ title }` — a titles-only table with all four hints derived and **zero** hand-typed safety
  overrides. Cost: `env-list` and `reopen` over-claim; both are noisy-not-dangerous. Residual risk to
  state explicitly: it depends on the convention that network calls live under `src/integrations`.
- **(b) Keep the declared table, but require a `file:line` evidence citation per row**, reviewed like
  `LOW_RISK_MUTATING_ALLOWLIST`, and drop S3 rather than ship a check that needs an exception list to go
  green.

Do not ship S3 in its stated form. This modifies Architect item 5's second clause.

### C5 — MEDIUM. The acceptance criteria cannot fail on any error this review process actually found.

E1 (`env-token-list` open-world), E2 (`env-load` additive), E3 (`worktrees-remove` rationale) were all
found by *reading source*. Run T1–T6 against the plan as written with all three errors present: **all
six pass green.** A test set that cannot detect the defects present in the document it accompanies is
not an acceptance criterion for the risky half of the change.

| Test | Falsifiable? | Judgement |
|---|---|---|
| T1 (title + annotations present) | Yes — missing table entry | Real. Keep. |
| T2 (`readOnlyHint === !mutating`) | Not for correctness — asserts the formula that produced the value | Refactor detector only. Agree with Architect item 12; keep, label honestly, note it also duplicates T1 + the boot throw. |
| T3 (key-set hygiene, both directions) | Yes | **Strongest unit test of the set.** Keep. |
| T4 (omission + destructive set) | Half tautological (`{mutating} \ ADDITIVE_ONLY`); the "read-only tools carry neither hint" half is real | Under C1 the tautological half disappears. |
| T5 (gated ⇒ destructive; converse not held) | First half is a theorem given the derivation; second half is a documentation assertion | Under C1 keep only the divergence pin, and say it is prose insurance, not a correctness test. |
| T6 (e2e served surface) | Yes — crosses a process boundary | Genuinely non-tautological, but proves **transport fidelity, not semantic correctness**: both sides derive from the same catalog. Say so. |

**Missing criterion:** nothing asserts the values are *right*, only that they are *transmitted
consistently*. Under C4(a) that gap closes structurally (nothing is declared). If the declared table
survives, the plan must say plainly that `openWorldHint` correctness rests on review, not on CI.

### C6 — MEDIUM. R6's mitigation is the mechanism that already failed.

R6 (`:463-467`) mitigates contestable `openWorldHint` values with *"each row carries its justification
in the table."* E1 is a row that **carried a justification and was wrong** — *"reads the local token
store; never calls Doppler"* against `env-token-list.ts:115-131`. Proposing the failed control as the
control is not a mitigation. R6 must either point at a real check (C4) or accept the conservative value.

Same shape in **R2** (`:440-442`): *"Mitigation: P1 and P4"* points at principles, not actions — and C2
shows P4 is not applied. R2 should name its one concrete instance: a host auto-approving `reopen`
because it advertises `readOnlyHint: true` while spawning editor and cmux windows.

### C7 — MEDIUM. No real-host verification, against the plan's own evidence standard.

§6 cuts `icons` for *"Zero measured host benefit: the two hosts measured on 2026-09-05 (Claude Code
2.1.261, MCP Inspector 2.5.0) were not observed to render tool icons."* The plan then ships
`annotations` with **no host measured reading them** and never puts them through that same rig. §8's
"Done means" asks only for *"a manual `tools/list` capture showing `title` and `annotations`"* — that is
a **server-side** capture proving the server emits what the server was told to emit. It cannot fail if
T6 passes.

**Minimal real-host verification to require, using the rig §6 already has:**
1. MCP Inspector 2.5.0 → connect → `tools/list` → confirm `title` renders as the display label (not
   `name`) and that `annotations` is present on the tool detail view.
2. Claude Code 2.1.261 → confirm whether `readOnlyHint: true` changes the permission/auto-approve
   affordance for a read tool (e.g. `version`) versus a write tool (e.g. `env-clear`).
3. Record the outcome in §6's table format — **including a null result.** "Measured; no host affordance
   observed" is a legitimate and useful outcome that still ships the change (the protocol field is the
   deliverable), but it must be on the record so the next `icons`-style decision is judged consistently.

The Architect did not raise this; §6's standard applied to §5's deliverable is the plan's sharpest
unexamined asymmetry.

### C8 — LOW. The Architect's E3 is understated: the schema *does* enforce it.

E3 says `worktrees-remove`'s `openWorld: false` holds "for a reason the plan does not state and that
**nothing enforces**." Something does. `src/commands/worktrees-remove/worktrees-remove.ts` MCP
`inputSchema` declares `versions: z.string()` — **required, not optional** — and `all` is absent from
the schema entirely; the description states *"Over MCP you MUST pass `versions` … the branch picker and
confirmation are unavailable without a TTY."* The `else` branch at `:129-141` (the only network path)
is therefore **structurally unreachable via MCP**, enforced by the input schema, not merely by TTY
convention. The correct rationale for the row is that schema fact. This strengthens Architect item 6
while correcting its premise.

### C9 — LOW. S2 is the same class of artifact the review condemns.

The Architect condemns `ADDITIVE_ONLY` as a hand-typed per-tool safety override, then proposes
`NOT_READ_ONLY = ['reopen']` — a hand-typed per-tool safety override — in the same document. If
`reopen`'s `readOnlyHint` is wrong, the root cause is `mutating: false` at
`src/lib/command-catalog/command-catalog.ts:296`, which the annotation work merely **exposed**. The
Architect's objection that reclassifying "fixes a protocol label by editing gate policy" has it
backwards: the catalog's `mutating` field is the source of truth and it is arguably wrong; adding a
second table that says "the source of truth is wrong here" is worse than fixing it. Reclassification is
small, guarded by the existing default-deny test, and needs one `LOW_RISK_MUTATING_ALLOWLIST` line.

I agree with Architect item 4 that silent deferral is unacceptable; I disagree on the remedy. Order of
preference: (1) reclassify `reopen` in this ticket, (2) S2, (3) ship `readOnlyHint: true` with an
explicit written admission. Not (4) defer silently.

### C10 — LOW. Nothing pins top-level `title` vs `annotations.title`.

§3 records that `title` on `BaseMetadataSchema` is distinct from `annotations.title`
(`src-CX2iR2pK.mjs:2515-2519`), then no test or instruction prevents an implementer setting the latter.
Some hosts prefer `annotations.title` when present. State: set top-level `title` only, leave
`annotations.title` unset, and add one assertion to T1.

### C11 — LOW. Scope is disciplined; two notes.

Ticket area `[DO]` is correctly declared (`:4`), matching the repo convention. Scope is otherwise tight
— §7's "Not touched" list is explicit and correct, and cutting `icons` is right for the reasons given.
Two items: §7.6 listing the plan file itself under "Files touched" is noise; and under C1 + C4(a) the
§7.2 diff shrinks substantially (no `ADDITIVE_ONLY`, no `idempotent`/`openWorld` columns), so §7.2 must
be re-rendered rather than patched.

---

## What must change (additive to the Architect's 14)

15. **Emit `destructiveHint` explicitly on every mutating tool; do not rely on the spec default.**
    `destructiveHint = entry.mutating ? true : undefined`, with **no `ADDITIVE_ONLY` array**. Cite the
    SDK evidence (`src-CX2iR2pK.mjs:1138-1144`, `:2698`; zero non-schema readers) in §3 so the next
    reader cannot re-propose omission. — *Replaces Architect item 5's S1 branch; a better answer to
    item 3 than removing one member.*
16. **Drop `idempotentHint` from the plan**, on the C3 ground (retry is the affordance it drives, so
    over-claiming is dangerous, so P4 gives no cover) — not on the "contestable judgements" ground. —
    *Agrees with S1's second half, different and stronger reasoning; supersedes Architect item 13.*
17. **Do not ship S3 as specified.** Choose C4(a) (derive `openWorldHint` from the import graph;
    `MCP_TOOL_PRESENTATION` collapses to `{ title }`) or C4(b) (declared table + `file:line` evidence
    per row, no static check). Record the choice and the residual risk. — *Modifies Architect item 5.*
18. **Reconcile P4 with the per-tool tables, or delete P4.** Add the C2 table to §1 showing every
    assignment against its spec default and direction of error. Items 15–17 make P4 compliant by
    construction; if any explicit under-claim survives, it needs a named argument, not a principle.
19. **Add a real-host verification step to §8 "Done means"**, per C7 steps 1–3, and record the result in
    §6's table format including a null result. State that the current "manual `tools/list` capture" is
    server-side and cannot fail independently of T6.
20. **Label each acceptance criterion with what it can and cannot detect** (C5 table). State explicitly
    that no test can catch a wrong `openWorldHint` under C4(b), and that T6 proves transport fidelity,
    not semantic correctness. — *Extends Architect item 12 from wording to the whole test set.*
21. **Rewrite R2 and R6 as actions, not restatements.** R6's current control is the one that failed
    (E1). R2 must name `reopen` as its concrete instance.
22. **Correct the `worktrees-remove` rationale to the schema fact** — `versions` is a required MCP
    input and `all` is absent, so the picker branch is unreachable by construction. — *Agrees with
    Architect item 6's conclusion; corrects its "nothing enforces" premise.*
23. **Prefer reclassifying `reopen` (`command-catalog.ts:296`) over introducing `NOT_READ_ONLY`.** If
    S2 is chosen anyway, say why a second override table beats fixing the source of truth. — *Agrees
    with Architect item 4 that silence is unacceptable; disagrees on the remedy.*
24. **Pin top-level `title`; assert `annotations.title` is unset** (C10).
25. **Re-render §7.2 after items 15–17** — the table and the derivation block both shrink. Drop §7.6.

**Agreements, no further comment:** Architect items 1, 2, 7, 8, 9, 10, 11, 14 are correct as written.
Item 3 is correct but is subsumed by 15. Items 4, 5, 6, 12, 13 are modified above.
