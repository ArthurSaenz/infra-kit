# Critic review — `docs/release-deploy-command-plan.md`, revision 5

**Verdict: APPROVE**, conditional on one editorial sweep (S-1 below). No design blocker remains. My three
carried acceptance-criterion blockers are closed, the four new ACs hold under the vacuity standard, and
the Option-H reversal did not lose the machinery it restored.

Scope, as directed: (a) my three remaining AC blockers, (b) the ACs of what changed, (c) the two rulings
asked for. Everything else is approved and untouched.

---

## First, a correction against me

Revision 4 records that `withEscape`'s `base?` parameter has **six callers, not zero**, and applies S1 to
the claim. In my revision-3 review I wrote *"`base?: PromptContext` has zero callers, so the required
parameter replaces dead weight. I verified nothing else competes for the slot."* **I did not verify it.**
It was supplied to me as established and I passed it through as verification, which is exactly the failure
S1 names, committed by the reviewer who proposed S1's enforcement.

It matters, because that fact was load-bearing for how strongly I endorsed the required parameter: I
called the cost "near-zero" partly on the strength of a grep I never ran. The plan's handling is right —
it re-derives §2.3 on different grounds rather than quietly re-justifying it, and the recovery (`base`
*is* a `PromptContext`, so the parameter widens rather than becoming a third) keeps all six callers valid.
That is a better outcome than the one I approved.

---

## Ruling 1: did the restored machinery keep its assertions across two reversals? — **Yes, all four, and two came back stronger**

Option G deleted the services field; Option H restored it. I checked each restored piece for prose
reinstated without its assertion:

| Restored piece | AC | State after two reversals |
|---|---|---|
| Conditional offer (`services` only when round 1 omitted it) | **P4** | **Stronger than revision 3.** Both directions survive, each asserting `schema !== null` first, and P4 gained a leg revision 3 did not have: *"no other provider's shape contains `services`/`service` for any params"* — which is the leg that matters now that four tools carry forms |
| Empty selection → `toArgs` returns `null` | **P12** | Intact, both halves, and the key-set-containment half now has its own named mutation ("introduce any other key → red") — the nit I raised in r2 and r3 |
| M2's throwing spelling (`z.array(z.string())`) | **P10** | **Stronger.** Revision 3 asserted sendability for the services shape; revision 5 asserts it *"for each of the four"* providers, and adds a second mutation (return a nested `z.object`) |
| R1b — a guessing agent silently removes the picker | §6 `:1136`, cross-referenced from §1.3 Option H `:389` | Intact as a residue, and correctly still a residue rather than being upgraded to a closure |

`§5.6`'s claim that `form discarded (narrowed)` is unreachable also survives correctly: it rests on the
conditional offer keeping `services` absent from round 1 (P4), which Option H preserves. Nothing there
reasons from a services-free schema.

**Nothing was reinstated in prose with the assertion lost.** The one place a reversal could have dropped
an AC silently — P4's conditionality, which is meaningless under G and load-bearing under H — is the one
that gained a leg.

---

## Ruling 2: does anything still reason from a superseded position? — **Yes, but not from Option G**

Your Option-G sweep is clean. I grepped for the residue shapes you named — "no array appears in any
form", "unreachable by construction", services-field-removed framing — and found none in the design. The
one Option-G artefact left is cosmetic: the ADR's alternatives line `:1182`, *"Option F — rejected: it
removes the env picker from the `-selected` path, **which Option G does not**"*, compares a rejected
option against a superseded one. F's rejection still stands under H (H keeps the env picker on all four),
so the conclusion survives; only the comparator is stale. One word.

**The unswept reversal is a different one, and it is in the ADR.** `whenHeadless` went from **required**
to **optional defaulting to `'refuse'`**, and the compile-time-obligation claim was explicitly withdrawn.
That withdrawal reached §0 (`:24-27`, "survives in **weakened form** — optional rather than required")
and §2.3 (`:253`, `:605`, both `whenHeadless?:`). It did **not** reach five other places:

| Line | Text | Problem |
|---|---|---|
| `:950` | "PR-0b — `withEscape`'s **required** `whenHeadless` parameter" | Execution section states the withdrawn signature |
| `:987` | G7's parenthetical: *"Largely enforced by `tsc` once the parameter is required"* | **The stated basis of an AC no longer exists.** G7's substance survives — it is now the primary mechanism for the raw-call bypass, not a backstop — but its rationale reads as an aside to a guarantee that was withdrawn |
| `:1180` | ADR title: "a **type-enforced** headless-behaviour contract" | The decision of record asserts type enforcement |
| `:1189` | ADR Decision: "a **required** `whenHeadless` parameter" | Same |
| `:1210` | ADR: "A **required** `whenHeadless` …" | Same |

This is material to the record rather than to the build — §2.3 plus §5.1 are unambiguous, and no
implementer would build the signature from an ADR title. But the ADR is what a later reader treats as the
decision, and it currently claims a guarantee the plan withdrew after finding it false. It also changes
how B7 (my original "the survey has no gate") reads: the survey is now discharged **by tests** — G6, G7,
G8 — rather than by the type system, and the plan should say that where it withdrew the stronger claim.

**S-1 (required sweep, not a re-decision):** correct those five statements, and `:1182`'s comparator.

---

## My three carried blockers

### B-r3-1 (G0f/G0g at the call site) — **closed for two of three sites outright; specified and honestly caveated for the third**

You asked whether an AC that specifies a fixture nobody has built is closed or merely deferred. The answer
splits, and the split is worth having explicitly:

- **`worktrees-add`, sites 2 and 3 — closed.** G0g asserts bytes at the call site with **individual**
  reverts named per site (*"Revert `:146` alone → 54 bytes appear; revert `:163` alone → the cmux leg
  fails"*), which is precisely the failure mode you named. The fixture is trivially buildable: I verified
  in an earlier round that `worktrees-add` needs only a git repo and `versions` supplied — no workflows,
  no `deploy-*.sh`, no AWS, no live `gh`. Nothing here is deferred. The row also carries two legs I did
  not ask for and that earn their place: that the same holds *after* PR-0b with the inline branch deleted
  (making PR-0b's deletion observable rather than aspirational), and the `--yes` CLI leg.
- **`local-deploy`, site 1 — specified to implementability, not demonstrated.** G0f's fixture must reach
  `:411`, which means passing `discoverServices` (`:316`, throws at `:318-324`), `eligibleServices`, and
  `runPreflight` (`:371`) — which calls `assertEnvMatchesAccount` (`preflight.ts:58-68`), i.e. it needs a
  stubbed AWS identity as well as a git repo, a clean tree, and executable stub `deploy-*.sh`. The plan
  names this and does not solve it.

**Ruling: closed, not deferred — but on a technicality that needs one clause to hold.** My standard is
about ACs that pass *for the wrong reason*. G0f as specified cannot: it asserts bytes at the call site
against a named individual revert. What it can do is fail to be built. That is a project risk, not a
vacuity — and the plan defends against the obvious downgrade itself, with *"the predicate assertion may
stay as a unit, but it is not the AC."* That sentence is protective, and I read it as such.

The missing clause: **E6 carries "the mutation must be EXECUTED, not described" and G0f/G0g do not.** That
obligation is exactly what stops a hard fixture quietly becoming an unrun row — and revision 1's G0d,
which the plan cites as its own lesson, failed in precisely that way. Extend the sentence to both rows,
and add that if the `local-deploy` fixture cannot be made to reach `:411`, the row is reported as **unbuilt**
rather than silently satisfied by the predicate unit test. One clause; not worth a round on its own.

### B-r3-2 (E6's second precondition) — **closed, and better specified than I asked**

E6 now pins both preconditions, names the door each one opens, and — the part I did not ask for and that
makes it durable — states them *in the row* rather than in the prerequisite prose, *"so that a later
'simplification' of the fixture reopens a named hole rather than a silent one."* The second precondition's
mechanism is correctly traced: omitting `version` sends `resolveDeployBranch` down `resolve-branch.ts:26`,
which throws through the **already-guarded** `pickReleaseBranch` before the env guard is reached — so the
lane would go green against a reverted PR-0b for a reason that has nothing to do with what E6 tests. That
is the right diagnosis, and it is one step sharper than the one I gave.

### B-r3-3 (P1(a) parameterized, and its mechanism) — **closed, and the correction is correct and is against me**

P1(a) is now parameterized over every candidate list the provider reads, and the log line names *which*
list was empty — stronger than the fix I asked for.

The mechanism correction is right, and I verified it: `z.enum([])` constructs fine; the `TypeError` comes
from `inputRequired.elicit()`, caught at `argument-form.ts:162-170` — **not** at `trySchema`'s
`:134-138`, which wraps `provider.buildRequestedSchema`. So at provider level the mutation yields a
**non-null** schema and P1(a)'s `=== null` leg reddens directly; M4's null-by-the-wrong-route hazard lives
one layer up in `buildArgumentForm` and is P10's territory. My revision-3 review attributed the throw to
the wrong catch and described a redness that would not have occurred. The plan caught it and says so.

---

## The four new ACs, at full strength

| AC | Mutation | Reddens? | Plausible mutation? | Verdict |
|---|---|---|---|---|
| **E1b** | drop the execution-time intersection | **yes** — one `gh` invocation is recorded and the tool returns `success: true` | Yes; it is the state of `main` today | **The load-bearing lane, and correctly constructed.** It asserts a *conjunction* — the enum contains `mobile` **and** the refusal fires **and** zero dispatches — so it is two-sided: filtering the enum reddens the first leg, dropping the refusal reddens the last two. It also fails closed if no form opens at all (the "enum contains `mobile`" assertion has nothing to read). The architect is right that argv recording is what separates refused from refused-but-dispatched; response shape cannot |
| **P4b** | filter the enum by round-1 `env` | yes | **Highly** — filtering is the obvious "improvement", and the architect's original blocker *points toward it* | **Best-aimed row in the plan.** It exists to defend a counter-intuitive decision against the most likely well-meaning regression, which is what an AC is for. Its stated reason is correct: `trySchema` runs on both rounds against `params` (`argument-form.ts:102-104`), so a filtered enum would be rebuilt against the round-1 env and validate the human's pick against an env they changed |
| **P13** | intersect against `parseServicesFromWorkflow()` alone; separately, use un-scoped `readWorkflowGates` | yes, both | Yes — the un-scoped read is the natural first implementation | **Non-vacuous in the way refusal tests usually are not:** it asserts *both* directions (`mobile`+`stage` refused, `mobile`+`dev` proceeds), so a blanket refusal fails the second leg. The two-workflow scoping leg is a genuinely separate defect with its own mutation (`collectGates` unions across files, `:90-92`) |
| **G8** | relax `release-create`'s `releases` to `.optional()` → six `'unreachable'` claims become false | yes | **This is not hypothetical — PR-1 performs exactly this operation on a different tool** | **Better than the `'unreachable'` spelling I proposed in r3.** I suggested a third spelling; the plan made it an *assertion* binding the spelling to a schema fact, which turns S3 from advisory into enforced. Sitting it beside G6 with the explicit statement that neither subsumes the other (`worktrees-add` has a promise and no blocking field; `release-create` has a blocking field and no promise) is the right partition |

**One weakness worth stating in G8**, carried over from my r3 note on G6. G8 asserts that a site declaring
`'unreachable'` has "a **required** field in the owning tool's `inputSchema` that blocks the path". The
mapping from *a required field exists* to *that field blocks this particular prompt* is not mechanical —
`release-create`'s six sites are all behind `releases`, but nothing in the assertion knows that. If the
site→field mapping is a hand-written table, G8 asserts the table agrees with the schema, which catches the
PR-1-shaped mutation it names (good) but not a mis-mapped site. **Cheap strengthening:** carry the field
name in the declaration — `whenHeadless: { unreachable: 'releases' }` — so G8 reads a per-site claim
rather than a table. Same shape as the fix I suggested for G6 (derive the claim set rather than list it).
Note, not a condition: the named mutation does redden, and the mis-mapping failure is a future hazard
rather than a present false green.

---

## Conditions and notes

**S-1 (required sweep, before implementation).** Correct the five surviving statements of the withdrawn
"required parameter / type-enforced" claim — `:950`, G7's parenthetical `:987`, ADR title `:1180`, ADR
Decision `:1189`, `:1210` — and say where the survey's discharge now lives (G6/G7/G8, tests, not `tsc`).
Also `:1182`'s Option G comparator. No decision changes; this is the record catching up with §0 and §2.3.

**N-1** — extend E6's "the mutation must be EXECUTED, not described" obligation to G0f and G0g, and state
that an unbuildable `local-deploy` fixture is reported unbuilt rather than satisfied by the predicate unit.

**N-2** — G8 should carry the blocking field name in the declaration so it reads a per-site claim rather
than a hand-written map; G6 likewise should derive its five-tool claim set from `getExposedMcpTools()`
descriptions rather than listing it, or a sixth claiming tool passes silently (§6.0's meta-guard).

**N-3** — P13 and G0f both say "red on `main` today", of code that does not exist on `main`. The honest
phrasing is that the *behaviour* they pin is wrong on `main`. Same loose wording flagged in r3; harmless,
but it is the phrasing that made revision 1's G0d look stronger than it was.

**N-4** — P10 needs a populated `availableServices` fixture, or §2.5's emptiness check fires first and the
row is red for the wrong reason. Carried unresolved from r2/r3; one sentence in the fixture prose.

**N-5** — PM-D1's *"that half is a real fix"* still overstates: `toArgs → null` closes the **empty**
`services` case; a non-empty auto-filled array is the same open vector as `env`, permitted because the key
is absent from `before`. Carried from r2/r3. One clause.

---

## Closing

Across five revisions this plan absorbed 18 blockers, three of them measurements that contradicted its own
text, and it reversed itself four times — twice on PR-D, once on the local-deploy form, once on
`whenHeadless`'s justification — each time recording the false claim rather than deleting it. Three of the
corrections were against reviewers, including two against me: the `base?` caller count, and P1's redness
mechanism. That is the behaviour S1 was written to produce, applied reflexively rather than selectively.

The acceptance criteria now do what §6.0 asks: every row I checked names a mutation a real implementer
could make, most name one someone has already proposed, and the two rows guarding the ordering property
and the live defects assert bytes on the protocol channel rather than error text. **Approved.** Do the S-1
sweep and build it.
