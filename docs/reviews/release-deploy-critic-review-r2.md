# Critic review — `docs/release-deploy-command-plan.md`, revision 3

**Verdict: ITERATE** — the design is approved. Three acceptance-criterion lines stand between it and
approval, and they are the same three I raised against revision 2, unaddressed because the revision
changed shape elsewhere. None requires re-arguing a decision.

Round 1: `docs/reviews/release-deploy-critic-review.md` (18 blockers). This review judges **revision 3**,
applies the vacuity standard hardest to the material added since revision 2 (`whenHeadless`, S1–S3, G0b,
G0g's second leg, G6, G7), and answers the two rulings asked of me.

---

## Ruling 1: is revision 3 better than revision 2, or churn? — **Better. Adopt it. But lead with the second reason, not the first.**

You asked me to tell you if your change was unnecessary churn rather than let it be adopted because you
proposed it. It is not churn, and the planner's own note is nonetheless correct that revision 2 was not
broken: PR-0a placed the `worktrees-add` default ahead of PR-0b, so `withEscape` was never reached at
those sites under MCP and no regression could occur. So the change fixes no bug in revision 2.

It is still the better design, for four reasons — and §2.3 leads with the weakest of them.

- **§2.3's stated reason is thin.** *"It removes the dependence on PR ordering"* — revision 2's ordering
  was explicit, and PR-0a had no dependencies to get wrong. That half does not carry the change.
- **The reason that does carry it is the second half of the same sentence, and it generalizes further
  than §2.3 claims.** §0.7's entire defect class is *an author added a prompt and did not think about the
  headless case*. `worktrees-add.ts:146` and `:163` exist because someone guarded `:127` correctly and
  then wrote two more prompts nineteen lines later. A required parameter makes that class
  **unrepresentable** rather than merely **surveyed**. No other mechanism in this plan does that.
- **It discharges B7 categorically, which a table cannot.** My B7 was "the survey has no gate, no
  artifact, no AC". Revision 2 answered it with §0.9 — a good table, and a markdown table that decays the
  first time someone adds a 24th site. `tsc` does not decay. Moving the survey from a document into the
  type system is the single strongest thing revision 3 does, and it is a categorical upgrade, not an
  incremental one.
- **It makes principle 5 true.** Revision 2's *"a prompt is never correct under MCP"* was false at
  `worktrees-add`, where the correct behaviour is a **value**, not a refusal. Revision 3's *"not prompting
  has two correct spellings, and which one applies is a per-site fact"* is the accurate generalization,
  and it reconciles the architect/critic conflict instead of picking a winner. §0.9's diagnosis of the
  architect's error is exactly right: the survey asked whether a refusal *removes a capability* and
  answered no, which is true about the prompt and misses that the correct answer was never "prompt or
  refuse" in the first place.
- **The cost is genuinely near-zero.** `base?: PromptContext` has zero callers, so the required parameter
  replaces dead weight. I verified nothing else competes for the slot.

**Acknowledged churn, honestly labelled:** §2.2 writes `worktrees-add`'s two sites once as inline
`isMcpMode()` branches in PR-0a and again as `whenHeadless: { value: false }` in PR-0b. The plan says so
outright and gives the reason (a live defect on an ungated exposed tool must not wait on a 23-site
type-level refactor). That is the right trade and the right disclosure.

### The risk you named is real and only partly mitigated

*"23 sites a reviewer will be tempted to fill in mechanically with whatever makes `tsc` pass."*

`tsc` forces an **answer**; nothing forces a **correct** answer, and `'refuse'` compiles everywhere and is
what a mechanical reviewer picks. Coverage of a wrong answer today:

| Site class | Count | What catches a wrong `whenHeadless` |
|---|---|---|
| Not MCP-reachable | ~13 | Nothing — and nothing needs to; the policy is unobservable there |
| Reachable, refuse is correct | 6 | G0a (bytes + throw), and the behaviour is what the tools already document |
| Reachable, a value is correct | 2 (`worktrees-add`) | **G0b**, plus **G6** because those two carry a `.describe()` claim |

So the exposed gap is narrow but real: **a future exposed tool whose correct policy is a value rather
than a refusal, and which carries no documented claim, is caught by nothing.** G6 only reaches tools that
already assert a behaviour; G7 only proves the parameter is present.

**Cheap fix, and it turns the declaration into the survey rather than into a policy knob:** make the
non-reachable case a distinct third spelling — `whenHeadless: 'unreachable'` — so that what each site
records is the *reachability finding*, not just a preference. A reviewer papering over a reachable site
then has to write `'refuse'` where `'unreachable'` was the honest answer, which is a visible claim in the
diff rather than an invisible default. It also gives G6 and G7 a set to bind against. Note, not blocker.

---

## Ruling 2: PR-0a's acceptance criteria — **the gap is unchanged, and §5.1's own header is the proof**

§5.1 is titled *"every row asserts bytes on stdout, not error text (S2)"*. **Two rows do not: G0f and
G0g — the two rows tagged `(PR-0a)`.** They assert predicate return values. S2 is the plan's own standing
rule, introduced this revision, and the only two rows that violate it are the two guarding live defects
on shipped tools in the change that ships first and standalone.

That is not a coincidence, it is the gap restated: **a predicate that returns the right value is not a
predicate that is called.** All three reverts stay green:

| Revert | G0f | G0g | Caught? |
|---|---|---|---|
| `local-deploy.ts:411` back to `!yes`, `shouldSkipConfirm` left correct and unused | green | green | **no** |
| drop the resolver term at `worktrees-add.ts:146`, keep `:163` | green | green | **no** |
| drop it at `:163`, keep `:146` | green | green | **no** |

**G7 does not cover this, and cannot.** G7's predicate is "sits behind `withEscape` with an explicit
`whenHeadless`" — false at every site during PR-0a, because the required parameter does not exist until
PR-0b. G7 is a PR-0b row (its own parenthetical says so: *"largely enforced by `tsc` once the parameter is
required"*).

**To your specific question — what G7 does against a site that declares `whenHeadless` correctly and
wires it to nothing:** for PR-0b onward, that state is **unrepresentable**, and this is the strongest
structural argument for your change. The policy executes *inside* `withEscape`; there is no separate
predicate left to forget to call, and the returned value flows into the `??` chain or the call throws.
The question's premise dissolves. It survives only for PR-0a, where the extracted predicates are wired by
hand — which is exactly the window where the ACs are weakest.

**The fix is the plan's own rule applied to its own exception.** Make G0f and G0g byte-asserting at the
call site, per S2:

- **`worktrees-add` (sites 2 and 3)** — adopt the architect's stdio e2e leg, **split per site**. The tool
  is ungated and needs only `mkdtemp` + `git init` — no workflows, no `deploy-*.sh`, no live `gh` — so
  §5.4's fixture already reaches it. Call it with `versions` supplied and assert stdout contains
  **neither** `Open created worktrees in GitHub Desktop?` **nor** `Open created worktrees in cmux?`, as
  two independent assertions, plus that every byte parses as JSON-RPC. Two literal strings, two
  individually falsifying rows. As written, PR-0a ships with **no wire-level evidence at all** while
  PR-1 — which lands later — gets E6; that ordering is backwards for the change that fixes shipped
  defects.
- **`local-deploy` (site 1)** — a wiring assertion for `:411`: either spy on the `withEscape` module and
  drive `runLocalDeploy` with `discoverServices`/`getProjectRoot` mocked, or extend the existing AST
  sweep with a rule that `:411`'s guard references the extracted predicate. The repo's own precedent is
  decisive here: `every-inquirer-site-is-escapable.test.ts:17-21` records that its earlier
  string-containment form *"green-lit `worktrees-add.ts`, a file that wraps two prompts and then calls a
  third raw"*, and was rewritten to be structural for that reason. Same file, same tool, same defect
  shape, one revision apart.

§2.2 is right that extraction is mandatory — I re-verified that revision 1's G0d was unreachable
(`runLocalDeploy` hits `discoverServices` at `:316`, throws at `:318-324`, and this checkout's
`devops/scripts/` holds only `lib`). Extraction solves reachability. It is not a substitute for wiring,
and revision 3 still treats it as one.

---

## The new ACs, individually: mutation, and whether an implementer could make it

| AC | Named mutation | Reddens? | Plausible? | Verdict |
|---|---|---|---|---|
| **G0b** | change a `{value:false}` site to `'refuse'` | **yes** — two independent assertions (zero bytes **and** returns `false`); a throw fails the second even though it emits no bytes | **Highly.** It is literally the architect's position, and `'refuse'` is what a reviewer filling in 23 sites picks by default | **Strongest new row.** It is the row that would have caught the reviewer conflict, and it is correctly two-sided |
| **G0g** (2nd leg) | key it on `confirmedCommand` instead → the `--yes` leg fails | **yes** | Yes — it is my B6, which a reader of round 1 would implement | **Converts the disagreement into an assertion, as you asked.** See the B6 ruling below. **Nit:** the row is ambiguous about whether `githubDesktop` and `cmux` are two assertions or one; they must be two, or reverting one site stays green |
| **G6** | change `worktrees-add`'s site to `'refuse'` while leaving `:377`'s text | yes | Yes | **Real, with a coverage hole** — see below |
| **G7** | add a raw `@inquirer` call in a reachable command | yes | Yes, and the sibling sweep proves the idiom works | **Real.** Correctly scoped: it catches the raw-call bypass `tsc` cannot see. **Limit worth stating:** it proves the parameter is *present*, never that the policy is *right* — a site declaring `'refuse'` where a value is correct passes G7 and is caught only by G6, and only if that tool carries a documented claim |
| **P10** | `z.array(z.enum(…))` → `z.array(z.string())` | yes | **Highly** — the tool's own declared type (`gh-release-deploy-selected.ts:258-259`) | Still the best AC in the plan; the only row asserting the schema is *sendable* |
| **P11** | write `undefined` for untouched fields | yes | **Highly** — `{...params, env: content.env}` is the obvious spelling | Real, and genuinely distinct from P6 |
| **P12** | return the merge for `services: []` | yes | Yes | Real. Nit unchanged: the key-set-containment half has no named mutation |
| **G0e** | add `!isTTY` to the shared guard | yes | **Highly** — revision 1's §2.2 said "all three clauses survive extraction" | Real, and correctly a *pass*-direction guard per principle 2's new clause. Nit: it pins today's behaviour rather than endorsing it; say so, or F-3 later reads as contradicting a decision |
| **G5** | remove the path from `plugin-ci.yml` | yes | Yes | Tautological in shape, legitimate as a config pin |
| **P1** | build before checking emptiness | yes, but not by the stated mechanism | Yes | **Real, wrong explanation, and a coverage gap** — see B-r3-3 |
| **E6** | revert PR-0b, executed | yes *if* the lane reaches `pickEnv` | Yes | **Real, one input still unspecified** — see B-r3-2 |

**G6's coverage hole.** The assertion is *"for every exposed tool whose description or `.describe()`
claims an MCP/no-TTY behaviour, the declared `whenHeadless` at the reachable site matches the claim"*, and
the plan then names the five tools. If those five are a hand-written list, G6 asserts a table agrees with
the code — which does catch a code change, but a **new** exposed tool that adds a TTY claim and no
`whenHeadless` mapping passes silently. That is §6.0's canonical shape: *a guard that must first find
something in order to check it will report success when it finds nothing.* **Fix, one line:** derive the
claim set by regex over `getExposedMcpTools()`'s descriptions rather than listing it, and assert every
member of that derived set has a mapping. Then a sixth claiming tool is a failure, not a silent pass.
Strong note, not a blocker — the present assertion does redden on its named mutation.

---

## B6: I was wrong, the plan is right, and the fact is stronger than the plan's citation

You asked me to confirm G0g converts the disagreement into an assertion. It does, and the underlying call
is correct — **against me.** I verified the mechanism:

`program.ts:92` declares `-y, --yes` and `:109` passes `confirmedCommand: options.yes` into the handler;
the same pairing repeats at `:140/:149`, `:160/:166`, `:234/:236`, `:243/:245`. **The CLI's `--yes` *is*
`confirmedCommand`.** So keying `worktrees-add`'s `githubDesktop`/`cmux` default on it would make
`infra-kit worktrees add --yes` resolve both to `false` on a TTY — breaking the documented resolution
order in the CLI direction while fixing it in the MCP direction. `:377`'s text is explicit about which
axis it means (*"interactive prompt (CLI) / false (MCP, no TTY)"*), and `isMcpMode()` is the key that
fixes exactly what is broken. **B6 is withdrawn.**

One note on the evidence: §2.2 cites `worktrees-add.ts:130-131` — *"Track --yes flag if confirmation was
interactive"* — which is `commandEcho` bookkeeping, i.e. a comment. The mechanism is the Commander wiring
at `program.ts:109`. Under the plan's own **S1** ("a docblock is evidence of intent, never of behaviour"),
cite the wiring. The conclusion is unaffected; the citation is one rung weaker than the fact it supports.

---

## Blockers

### B-r3-1 — G0f and G0g are the only §5.1 rows that violate §5.1's own S2 header, and they leave all three PR-0a sites without a call-site assertion.
Reverting any one of the three sites leaves both rows green (table above). G7 cannot cover PR-0a, because
the required parameter does not exist until PR-0b. This is the failure shape
`every-inquirer-site-is-escapable.test.ts:17-21` records having already happened once, on `worktrees-add`.
**Fix:** apply S2 to G0f/G0g — the architect's stdio e2e leg on `worktrees-add`, split into two
assertions on the two literal prompt strings, plus a wiring assertion for `local-deploy.ts:411`.

### B-r3-2 — E6 still does not specify that `version` is supplied, and omitting it restores the vacuity the row exists to remove.
The row now spells out the empty-env-list vacuity, correctly. It does not name the tool or the other
input. After PR-1 `version` is `.optional()` too, and omitting it sends `resolveDeployBranch(undefined)`
down `resolve-branch.ts:26` — `getReleasePRsWithInfo()` then `getJiraDescriptions()` — against a stub `gh`
specified only as "recording argv", which dies on `JSON.parse` **before** `pickEnv`. Nothing prompts and
E6 is green against a reverted PR-0b. **Fix, one clause:** *"…on `gh-release-deploy-all`, supplying
`version` (which short-circuits at `resolve-branch.ts:22` and keeps the lane off the network) and omitting
`env`."* This also matters for R6, since E6 is the only mechanical enforcement of PR-0b → PR-1.

### B-r3-3 — P1(a) is unparameterized, so the `availableServices`-empty case §2.5 designs for is untested; and its stated redness mechanism is wrong.
§2.5 constraint 2 (`:538-539`) correctly requires the explicit `return null` for envs, releases **and**
`availableServices`. P1(a) says only *"Empty list → `null`"*. A test exercising empty **envs** satisfies
it while leaving untested the one path that kills the entire form — env dropdown included — for
`gh-release-deploy-selected`. **Fix:** parameterize P1(a) over all three lists.

Separately, P1's stated mechanism is wrong: `z.enum([])` does not throw at construction — M3's own table
shows the `TypeError` comes from `elicit()`, one layer above the provider — so a `buildRequestedSchema`
that builds before checking emptiness returns a **non-null** `ZodObject` and P1(a) reddens on its
`=== null` assertion directly, with the log-line clause as belt-and-braces. Outcome right, explanation
wrong, and §6.0's third standing rule is precisely that a named mutation must be checked against the
assertion rather than reasoned about.

---

## Notes

- **N-r3-1** — add `whenHeadless: 'unreachable'` as a third spelling, so the declaration records the
  reachability finding rather than a preference (Ruling 1).
- **N-r3-2** — G6 should derive its claim set from `getExposedMcpTools()` descriptions, not list five
  tools, or a sixth claiming tool passes silently (§6.0's meta-guard).
- **N-r3-3** — G0g must state that `githubDesktop` and `cmux` are two assertions, or reverting one site
  stays green.
- **N-r3-4** — §2.2 should cite `program.ts:109`, not `worktrees-add.ts:130-131`'s comment, per S1.
- **N-r3-5** — PM-D1's *"that half is a real fix"* overstates. `toArgs → null` closes the **empty**
  `services` case only; a non-empty auto-filled array is the same open vector as `env`, permitted by
  `narrowsArgs` because the key is absent from `before`, and unmentioned. One clause.
- **N-r3-6** — G0e pins existing non-TTY behaviour rather than endorsing it; say so, or F-3 reads as
  contradicting a decision.
- **N-r3-7** — §0.9 is a hand-audited snapshot for the ~13 not-reachable rows; after PR-0b `tsc` carries
  the reachability claim only if N-r3-1 is adopted. Until then nothing re-checks it.
- **N-r3-8** — say that revision 2's G0b (the `jsonOutput` refusal) was deliberately removed with the
  clause's deferral to F-3, not dropped. The letter is now reused for a different row, which will confuse
  anyone diffing the revisions.
- **N-r3-9** — P10 needs a non-empty `availableServices` fixture, or §2.5 constraint 2 fires first and the
  row is red for the wrong reason.

---

## Disposition of round-1 and round-2 blockers

All 18 round-1 blockers are closed. Round 2's three carry forward unchanged in substance as B-r3-1
through B-r3-3 — not because the revision ignored them, but because revision 3 reworked §2.3 and §0.9
rather than §5.1's PR-0a rows, §5.4's E6 row, or §5.2's P1 row.

**What revision 3 got that neither review did.** §0.7's finding that `tool-handler.ts:455-458` — the
chokepoint this entire increment runs through — itself says an unguarded call *"would hang on an inquirer
prompt"*, when the measurements show it writes 54–60 bytes and desynchronises. That is S1 caught in the
codebase, in the one file that matters most, by the plan's own new rule applied reflexively. S2 (assert
bytes, not message text) is the right invariant and I have no quarrel with it — only with the two rows
that do not follow it. And §2.3's refusal to adopt either reviewer's position, with a stated reason why
each is wrong on the facts, is the correct handling of a reviewer conflict.

The design is approved. Fix the three AC lines and it is done.
