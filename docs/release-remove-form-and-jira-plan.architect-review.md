# Architect review — `docs/release-remove-form-and-jira-plan.md`

Reviewed at HEAD `4818ee4`, 2026-09-15. Every `file:line` the plan cites was opened; all resolve (two drift by a few lines, noted in #9). `«rr»` as in the plan.

## Verdict: SOUND-WITH-CHANGES

The seam is the right one (`formProvider` behind `argument-form.ts`, `src/lib/**`-only imports), the enumeration is byte-for-byte the CLI picker's (`«rr»:886` → `getReleasePRsWithInfo`), the `null`→gate→`assertMcpRemoveInput` fallback is coherent, and the Jira reversal removes every `isMcpMode()` branch in `«rr»` (:175 stays, :234 stays, :260 and :770 go). What survives are two refusal texts that still name a CLI-only exit over MCP, one stale comment outside the plan's grep, and an unmeasured latency assumption on which the whole form depends.

## Antithesis (steelman)

- **Single-select.** The real cleanup session is "several stale releases": A1 costs N forms × 2 `gh` enumerations × N gates, where one multi-select would enumerate once. Counter: `releaseRemove` is single-target with a per-release residue report (`«rr»:915-918`); an agent loops. **Synthesis:** keep A1; have the description say "one release per call — repeat for more" so the agent does not try `versions`.
- **`moveIssuesTo` exposed, `skipJira` not.** The asymmetry rests on "the result is silent about a live artefact" — but the gate shows `skipJira: true`, and `findVersionByName` is a read, so a `skipJira` that still REPORTS `jiraVersion` is implementable (only D2d's unconfigured case needs the no-query path). Counter: that is the retired `'manual'` under another name, exactly the ambiguity the plan removes. **Synthesis:** B1 stands; the honest agent-facing exit for "keep the fix version" is "do not remove from here", and the plan says so.
- **Dropping `'manual'`.** Nothing in the NEW server produces it — but the plugin skill (marketplace) and the global CLI (npm) are not installed in lockstep on a consumer machine (memory: consumers run the global infra-kit). An old server answers `manual` to a new skill; a new server answers `removed` to an old skill that promises "never removed". **Synthesis:** drop it, but state the skew window in §11 and accept it explicitly.

## Tradeoff tension

**Domain-blind gate vs. inventory consent (D12).** On the CLI the human consents over `buildConfirmMessage` (fix version name, counts, move target); over MCP the human approves `{version}` and the only Jira context is what the agent relays from prose. The other side: domain state in the gate breaks the chokepoint's design, and per-release counts in the form cost N Jira calls. A cheaper middle exists: `getJiraDescriptions` already calls `getProjectVersions` (`release-utils.ts:222`), which returns `released`/`archived` per version — the rows could carry `(Jira v1.2.5, unreleased)` at zero extra network, most of the CLI line minus counts. Optional, but it is the one place parity with the CLI's consent screen can be recovered within budget.

## Principle violations (the plan's own principles vs its decisions)

- **P2 (a refusal names a reachable exit)** — `«rr»:249` (released/archived, marked "unchanged" in D7) says "or remove the release without it via --skip-jira": refused over MCP → DD-3's shape. `«rr»:591` (residue) appends "Re-run `infra-kit release remove --version …`" to EVERY step failure, including the D9-forked TOCTOU refusal (`buildResidueError` :597-602 prepends the refusal, then this) — two contradictory instructions in one message.
- **P1 (parity is the test)** — parity of SOURCE, not of availability: the CLI picker has no deadline; the form dies silently at 3 000 ms (`argument-form.ts:43`) on two SEQUENTIAL `gh pr list --search` calls (`gh-release-prs.ts:78,81`). Unmeasured (release-form measured its ls-remote at 1.65–1.88 s; two search-API calls are plausibly comparable each).
- **P3 wording** — "never blocks past `FORM_DEADLINE_MS`": `withDeadline` abandons, never cancels (`deadline.ts:14`); the gh children keep running, and again on round 2. The chokepoint stops waiting; the provider does not stop.

## Defects

1. **SHOULD** `«rr»:249` — fork the released/archived remediation on `isMcpMode()` like `:234-235` (MCP: "un-release it in Jira first"); add a case to the count-guard describe.
2. **SHOULD** `«rr»:591` — fork the residue's re-run sentence on `isMcpMode()` (MCP: "re-call release-remove with the same version; completed steps are skipped"); the new toctou MCP `it` must assert the WHOLE remediation contains no `infra-kit release remove`.
3. **SHOULD** `command-catalog.ts:666-668` — openWorld comment "the delete is the one step it never attempts there" is stale; not in D14 and outside AC-12's grep paths. Add the path to AC-12.
4. **SHOULD** Latency — measure `getReleasePRsWithInfo` three times on a consumer repo before choosing D4's budgets; parallelise the two searches in `fetchAllReleasePRs` (`Promise.all`, benefits the CLI picker too) or give gh its own in-provider budget with a log line. PM-1 cannot catch an environmental miss.
5. **SHOULD** `isFormable` = `version === undefined` makes `{ moveIssuesTo: 'x' }` formable → the "blind reassignment" B4 was rejected for is reachable via round-1 `moveIssuesTo` + form. Either `isFormable` is false when `moveIssuesTo` is present (gate, then refuse "name the release first") or accept it explicitly with an `f8` case; today the plan's B1 row ("first pass carries `version` only") is only true for a well-behaved agent.
6. **NIT** D9 "(the token is spent)" is false: tokens are TTL- and argument-bound, not single-use (`confirm-token.ts:21-22`); the same args + old token re-enter the handler (benign: a resume). Rest the skill's "never under the old token" on argument binding.
7. **NIT** Skew window (see antithesis 3) — record in §11 Consequences.
8. **NIT** `e-rr1` witness: on the fixture the likelier thrower is the `gh` stub's `exit 97` from `fetchPRByHead` (`pr-status.ts:17` — `gh pr list --head` matches no stub case) or `assertManagementContext`, not `getInfraKitConfig`/`assertJiraRemovable`. The failed-not-refused pair holds regardless; say "any pre-mutation throw".
9. **NIT** Cites: `runStep`'s comment is `«rr»:533-537`, `outcomeOf`'s doc `:500-503`. `f3` tests `releaseBranchLabels` on a mock — `getReleasePRsWithInfo` already filters unparseable head refs (`gh-release-prs.ts:153`), so it is a helper test, not a provider-input test.
10. **NIT** `resolveMoveTarget` (`«rr»:363-373`) checks existence only; an agent can name a RELEASED target and move issues into shipped scope. Pre-existing on the CLI; the `JiraVersion` already carries the flags. Record as out of scope or add the check.
11. **NIT** `version: ''` passes `z.string().optional()`, is not formable, and lands on a gate that will be refused; env-load treats `config: ''` as formable. Pick one and pin it in `f1`.

## Confirmed (no change needed)

Confirm-gate/HMAC: adding an optional `moveIssuesTo` changes nothing in `stripGateKeys` canonicalisation when absent; `resolvedArgs` deep-equals `{version}` in `e-rr1`; the snapshot grows by exactly the one `input` key (`.snap:229-233`). D5 drift lands on `formDiscarded` → gate → refused, correct direction. `e-rr1`–`e-rr3` are feasible on `makeEnvPickerFixture` (`gh` stub answers both `pr list --base` searches; `JIRA_*` scrubbed; `connectLegacyFormClient` :987, `connectManualModern` :1013, `AUTHORED_TOOL_NAMES` :1957). TDZ rule holds for the proposed module.

## Revision 2 (2026-09-15) — verdict: SOUND

Re-verified against HEAD `4818ee4` after the §12 revision log. All five SHOULD items are addressed in the text; the three lead-flagged checks:

1. **Step 0 `Promise.all` in `fetchAllReleasePRs` is safe.** `gh-release-prs.test.ts:33-70` mocks `$` by command substring (`--base main` at `:66`, everything else falls to the release set) — order-agnostic. The one order-sensitive assertion (`:255`, `logger.warn.mock.calls[0]`) reads `warnIfTruncated`, which still runs dev-then-main AFTER both awaits. The e2e `gh` stub is one process per invocation, so concurrency is a non-issue there. A second rejection inside `Promise.all` is swallowed, not unhandled.
2. **Forking `:591` leaves the CLI residue byte-identical** — the plan replaces only the MCP branch's sentence; the CLI branch keeps `Re-run \`infra-kit release remove --version …\``. `release-remove-resume.test.ts`/`-order.test.ts` (CLI path) stay the regression pin.
3. **Principle-2 list is complete for refusals.** Every CLI-only string reachable over MCP in `«rr»`: `:235` (deliberate human hand-off, kept), `:251`, `:270`, `:591`, `:755` (all forked in D7/D9), plus the D6 `skipJira` refusal (deliberate hand-off). `:893`/`:911` are unreachable over MCP (refused at `:177` first); `:704` is the PR comment; `:947-949` is `commandEcho` (informational, by design across tools).

Remaining, none blocking:

- **NIT** `«rr»:292` `assertSomethingExists` remediation says "check the spelling against \`infra-kit release list\`" — reachable over MCP on a typo'd `version`; the MCP spelling is the `gh-release-list` tool. Same fork pattern, one line.
- **NIT** The TOCTOU remediation is at `«rr»:755`, not `:753` (`:753` is the `refuse({` opener).
