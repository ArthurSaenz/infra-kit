#!/usr/bin/env node
//
// Blocks agent-initiated deployments; reading workflow state stays allowed. Deploys must go
// through infra-kit (which refuses ad-hoc `prod`), not straight to GitHub. A tripwire, not a
// wall — the durable control is server-side.
//
// Deliberately self-contained (no local imports) so no sibling-hook bug can disable it, and
// invoked as `node <path>` so a stripped exec bit can't turn a block into a silent pass. Blocks via
// a PreToolUse permissionDecision:"deny" (exit 0 + JSON), which holds even under bypassPermissions /
// --dangerously-skip-permissions — the mode where a settings deny rule would be skipped.
//
// Relationship to permissions.deny: this hook is a near-superset of the deny prefixes (it also
// catches the deliver commands, spaced `ik release deliver` included). deny's value is
// layer-independence — it survives this hook being skipped/deleted — not extra coverage. And
// because `curl` is on the allow list, this hook is the SOLE guard against a curl/wget call to
// the workflow-dispatch endpoint. Keep both.
//
// WHAT STAYS OPEN — the tripwire framing above is load-bearing, so the holes are written down
// rather than implied away:
//   - `bash script.sh` — the file is never read. Write-then-run across two Bash calls is the same
//     hole with an extra step.
//   - Prefix arity, direct case: `env -i gh workflow run x`, `nice -n 10 gh …`. Stripping is
//     arity-blind, so a value-taking prefix leaves its value at argv[0]. The wrapper gate rescues
//     the wrapped form; the direct form stays open.
//   - `bash -c "./dx-release-deliver"` and `bash -c "/usr/local/bin/dx-release-deliver"` —
//     RE_RAW_DELIVER_PREFIXED is `/`-blind, so a pathed deliver inside a wrapper is not matched.
//     The unwrapped forms ARE caught, by the argv[0] head check.
//   - A QUOTED argv[0] alongside a shell-wrapper token: `"gh" workflow run x bash`. basename()
//     strips quotes for the positional path, but the raw gh-phrase regexes read the original text
//     and `\bgh\s+workflow` does not match `"gh" workflow`. The pre-hardening hook allowed this
//     too, so it is a gap rather than a regression.
//   - Token-internal quoting (`g"h"`), command substitution (`$(which gh)`), backticks, base64 or
//     any other encoding, aliases, shell functions, PATH shadowing, symlinks, heredocs.
//   - Dispatch assembly that never spells `/dispatches` as a contiguous string.
// Accepted, not overlooked. The durable control belongs server-side.

import { readFileSync } from 'node:fs';

// The workflow-dispatch endpoint, matched regardless of HTTP method — `gh api` POSTs implicitly
// once -f/-F is present, so keying on "-X POST" would miss the obvious bypass.
//
// The boundary class carries quotes and shell operators, not just `/` and `?`. Quotes catch
// `gh api "…/dispatches"`. The operators catch the URL being ASSEMBLED rather than written
// literally — `P=/repos/…/dispatches; curl "https://api.github.com$P"` terminates the path with
// `;`, and `&` and `|` are that same shape with a different terminator. Dropping `&` and `|` was
// measured to reopen 16 endpoint-reaching shapes, `gh api …/dispatches|jq` among them, so they
// stay. A leading `/` is still required, which is what keeps `ls dispatches/` allowed.
const RE_DISPATCH = /\/dispatches([/?"';&|]|\s|$)/i;
const RE_GITHUB_API = /api\.github\.com/i;
const RE_ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// infra-kit's prod-delivery command across both naming eras and the `dx-` wrapper; anchored to a
// single token so `deploy-all` and paths like `scripts/deliver` don't match.
const RE_DELIVER = /^(dx-)?(release-)?deliver$/i;

// A shell name anywhere in a segment means argv positions stop describing what will run, because
// the real command sits inside a quoted payload. Gating on argv[0] alone is not enough: every
// value-taking prefix (`timeout 60`, `nice -n 10`, `env -i`, `stdbuf -oL`, `xargs -I{}`) leaves its
// own value at argv[0] and disarms the gate. That is an arity problem, and no membership list fixes
// it — hence "any token", which needs no arity knowledge.
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);

// Stripped from the head of a segment so the real command reaches argv[0]. Value-taking members are
// deliberately included even though stripping them leaves their value behind: the wrapper gate above
// is what covers that case, and stripping still helps the value-less forms.
const PREFIX_COMMANDS = new Set([
  'sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'eval', 'nohup', 'nice', 'stdbuf', 'time', 'xargs',
]);

// Raw-string counterparts, used ONLY when a shell wrapper is present — see checkRawShell.
const RE_RAW_WF_RUN = /\bgh\s+workflow\s+run\b/i;
const RE_RAW_RERUN = /\bgh\s+run\s+rerun\b/i;
const RE_RAW_GH_API = /\bgh\s+api\b/i; // MUST be ANDed with RE_DISPATCH — `gh api` alone is a read.

// "deliver" is ordinary product vocabulary ("feat: deliver emails"), so the raw path will not match
// it bare. A name that self-identifies as infra-kit's delivery entrypoint counts on its own; a bare
// `deliver` counts only with an infra-kit-ish tool in the same segment.
const RE_RAW_DELIVER_PREFIXED = /(?<![\w/-])(dx-|release-)(release-)?deliver(?![\w/-])/i;
const RE_BARE_DELIVER = /(?<![\w/-])deliver(?![\w/-])/i;
const RE_INFRA_TOOL = /\b(ik|infra-kit|pnpm|npm|npx|pnpx|yarn|node)\b/i;

// Head form of the same theory: only the self-identifying entrypoint names. Deliberately NOT shared
// with checkInfraKit's RE_DELIVER — there argv[0] is already an infra tool, so a bare `deliver`
// token has its context by construction. Sharing this stricter form there was measured to fail open
// on `ik release deliver`, `pnpm exec ik release deliver`, `node ./bin release deliver`, `ik deliver`.
const RE_DELIVER_HEAD = /^(dx-|release-)(release-)?deliver$/i;

// Emit a PreToolUse "deny" decision. Uses the JSON permissionDecision channel (exit 0 — JSON is
// only read on exit 0), not exit-2, because a permissionDecision:"deny" holds even under
// bypassPermissions / --dangerously-skip-permissions, where a settings deny rule does not. `reason`
// is surfaced to the model.
function denyDecision(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

// Fail closed: we could not prove the call is safe, so deny it.
function failClosed(reason) {
  denyDecision(`block-deploy: ${reason} — failing closed.`);
}

function deny(reason) {
  denyDecision(
    [
      `BLOCKED by deploy guard: ${reason}`,
      '',
      'Deploying to a non-prod environment IS allowed — but it goes through infra-kit,',
      'which enforces the deploy rules. Use the MCP tool:',
      '    mcp__infra-kit__gh-release-deploy-all         # dev / stage / personal envs',
      '    mcp__infra-kit__gh-release-deploy-selected    # a subset of services',
      'or the CLI:',
      '    pnpm exec infra-kit release-deploy-all',
      '    pnpm exec infra-kit release-deploy-selected',
      '',
      "prod is DELIVERED, never deployed ad-hoc — and delivery is a human's call:",
      '    pnpm dx-release-deliver                       # run by a human, not by you',
      '',
      'Reading workflow state is allowed: gh run list / view / watch, gh workflow view.',
    ].join('\n'),
  );
}

// Two-char operators before their single-char prefixes.
function splitIntoSegments(text) {
  return text
    .replaceAll('&&', '\n')
    .replaceAll('||', '\n')
    .replaceAll(';', '\n')
    .replaceAll('|', '\n')
    .replaceAll('&', '\n')
    .split('\n');
}

// Hand-rolled rather than imported from node:path, to keep this file dependency-free (see header).
// Quote-stripping first, so `bash"` and `bash` reach the same verdict — without it the wrapper gate
// fires or not depending on where a quote lands relative to whitespace, which makes a deny
// unexplainable. Stripping can only make the gate arm MORE often, which is the fail-closed direction.
function basename(token) {
  const unquoted = token.replace(/^["']+|["']+$/g, '');
  return unquoted.slice(unquoted.lastIndexOf('/') + 1).toLowerCase();
}

// Strip leading prefix commands and `VAR=val` assignments, else argv[0] is "GH_TOKEN=x" or "env"
// and the checks miss. `stripped` reports whether a PREFIX_COMMAND was consumed, so a segment that
// is nothing BUT prefixes can fail closed rather than silently pass. Assignments deliberately do
// not set it: `FOO=bar && pnpm test` is benign and must not fail closed.
function tokenise(segment) {
  const raw = segment.trim().split(/\s+/).filter(Boolean);
  const argv = [];
  let stripping = true;
  let stripped = false;

  for (const token of raw) {
    if (stripping) {
      if (PREFIX_COMMANDS.has(basename(token))) {
        stripped = true;
        continue;
      }
      if (RE_ENV_ASSIGN.test(token)) continue;
      stripping = false;
    }
    argv.push(token);
  }

  return { argv, stripped };
}

// Positional argv match, never substring: `gh run rerun` re-runs a deploy, `gh run list` reads.
function checkGh(argv, segment) {
  const verb = (argv[1] ?? '').toLowerCase();
  const object = (argv[2] ?? '').toLowerCase();

  if (verb === 'workflow' && object === 'run') {
    deny('`gh workflow run` bypasses infra-kit and dispatches a workflow directly.');
  }
  if (verb === 'run' && object === 'rerun') {
    deny('`gh run rerun` re-executes a previous run, deploy runs included.');
  }
  if (verb === 'api' && RE_DISPATCH.test(segment)) {
    deny('`gh api` against the workflow-dispatch endpoint (it POSTs implicitly on -f/-F).');
  }
}

// Same endpoint via raw HTTP — reaches GitHub with the same token, no `gh` in sight.
function checkHttp(segment) {
  if (RE_GITHUB_API.test(segment) && RE_DISPATCH.test(segment)) {
    deny('direct HTTP call to the workflow-dispatch endpoint (bypasses every gh rule).');
  }
}

function checkInfraKit(argv) {
  for (const token of argv.slice(1)) {
    if (RE_DELIVER.test(token)) {
      deny(
        `\`${token}\` merges the release PR into main and deploys prod — irreversible, and a human's call.`,
      );
    }
  }
}

// A shell wrapper is present, so argv positions are meaningless — the real command sits inside a
// quoted payload this hook deliberately does NOT parse. An earlier design did parse it, by
// recursing into `-c` payloads, and that failed OPEN: `splitIntoSegments` is quote-blind, so it cut
// payloads in half and the resulting fragment matched nothing. Matching phrases against the ORIGINAL
// command string instead is coarser and over-blocks, but it cannot be defeated by where the split
// lands — and a false deny announces itself, while a false allow is silent.
function checkRawShell(command) {
  if (RE_RAW_WF_RUN.test(command)) {
    deny('`gh workflow run` inside a shell wrapper — dispatches a workflow directly, bypassing infra-kit.');
  }
  if (RE_RAW_RERUN.test(command)) {
    deny('`gh run rerun` inside a shell wrapper — re-executes a previous run, deploy runs included.');
  }
  // The AND is essential: without it `gh api repos/o/r` — a blessed read — would be denied.
  // Note this check no longer decides any VERDICT: the command-wide RE_DISPATCH check at the end of
  // this function subsumes it (its condition is a strict subset), so deleting this block changes no
  // allow/deny outcome. It survives to name the specific rule that was hit, which is what the model
  // sees. Verified by deletion: the suite stays green without it.
  if (RE_RAW_GH_API.test(command) && RE_DISPATCH.test(command)) {
    deny('`gh api` against the workflow-dispatch endpoint inside a shell wrapper.');
  }
  if (RE_RAW_DELIVER_PREFIXED.test(command) || hasBareDeliverWithTool(command)) {
    deny(
      "a `deliver` command inside a shell wrapper — delivery merges the release PR into main and deploys prod, a human's call.",
    );
  }
  // The endpoint can be assembled from pieces (`P=/…/dispatches; curl "https://api.github.com$P"`),
  // which splits `api.github.com` and the path into different segments so checkHttp never sees both.
  // Matching command-wide is what closes that.
  if (RE_DISPATCH.test(command)) {
    deny('the workflow-dispatch endpoint appears inside a shell wrapper — this hook is the only guard on that endpoint.');
  }
}

// Bare `deliver` is common English, so it only counts alongside an infra-kit-ish tool in the SAME
// segment. Segment scope matters: command-wide would match `rg deliver . && pnpm build`.
function hasBareDeliverWithTool(command) {
  return splitIntoSegments(command).some(
    (segment) => RE_BARE_DELIVER.test(segment) && RE_INFRA_TOOL.test(segment),
  );
}

// Everything runs inside a fail-closed boundary: any unexpected throw denies rather than crashing
// (an uncaught error would exit non-zero-but-not-2, which does NOT block).
try {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    failClosed('unparseable hook input');
  }

  const toolName = input.tool_name ?? '';
  if (!toolName) failClosed('missing tool_name');
  if (toolName !== 'Bash') process.exit(0);

  const command = input.tool_input?.command ?? '';
  if (!command) process.exit(0);

  for (const segment of splitIntoSegments(command)) {
    if (!segment.trim()) continue;

    const { argv, stripped } = tokenise(segment);

    // Nothing left after stripping means the segment was prefixes all the way down (`env`, `time`,
    // `echo x | xargs`). We cannot say what it would have run, so we do not guess. Accepted cost:
    // `env | grep DOPPLER` is routine here after `ik env-load`, and it denies. Deliberate.
    if (argv.length === 0) {
      if (stripped) failClosed('command consumed entirely by prefix stripping');
      continue;
    }

    const head = basename(argv[0]);

    // Runs on every segment, not just curl/wget heads: it is a pure regex over the segment with no
    // argv dependency, so gating it on a head can only lose coverage. Placed before the wrapper arm
    // so a wrapped curl is caught segment-wise whenever the URL survives the split intact.
    checkHttp(segment);

    if (RE_DELIVER_HEAD.test(head)) {
      deny(
        `\`${argv[0]}\` is infra-kit's delivery entrypoint — it merges the release PR into main and deploys prod. Irreversible, and a human's call.`,
      );
    }

    // Must precede the switch, and cannot BE a switch case — a switch cannot dispatch on Set
    // membership.
    //
    // On the `continue`: the raw dispatch and deliver checks ARE supersets of their positional
    // counterparts, so skipping the switch cannot lose those denies. The two gh-PHRASE checks are
    // not — `basename()` strips quotes for the positional path, but the raw regexes read the
    // original text, so `\bgh\s+workflow` misses `"gh" workflow run`. That costs nothing today
    // (the pre-hardening hook allowed those shapes too, its discriminant being an exact match) but
    // it is a gap, not a proof, and it is recorded in WHAT STAYS OPEN above.
    if (argv.some((token) => SHELL_WRAPPERS.has(basename(token)))) {
      checkRawShell(command);
      continue;
    }

    switch (head) {
      case 'gh':
        checkGh(argv, segment);
        break;
      // curl / wget need no case — checkHttp runs on every segment above.
      case 'pnpm':
      case 'npm':
      case 'npx':
      case 'pnpx':
      case 'yarn':
      case 'node':
      case 'infra-kit':
      case 'ik':
        checkInfraKit(argv);
        break;
    }
  }

  process.exit(0);
} catch (err) {
  failClosed(`internal error: ${err?.message ?? err}`);
}
