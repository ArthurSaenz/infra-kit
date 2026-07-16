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

import { readFileSync } from 'node:fs';

// The workflow-dispatch endpoint, matched regardless of HTTP method — `gh api` POSTs implicitly
// once -f/-F is present, so keying on "-X POST" would miss the obvious bypass.
const RE_DISPATCH = /\/dispatches([/?]|\s|$)/i;
const RE_GITHUB_API = /api\.github\.com/i;
const RE_ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// infra-kit's prod-delivery command across both naming eras and the `dx-` wrapper; anchored to a
// single token so `deploy-all` and paths like `scripts/deliver` don't match.
const RE_DELIVER = /^(dx-)?(release-)?deliver$/i;

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

// Strip leading `sudo` and `VAR=val` assignments, else argv[0] is "GH_TOKEN=x" and checks miss.
function tokenise(segment) {
  const raw = segment.trim().split(/\s+/).filter(Boolean);
  const argv = [];
  let stripping = true;

  for (const token of raw) {
    if (stripping) {
      if (token.toLowerCase() === 'sudo') continue;
      if (RE_ENV_ASSIGN.test(token)) continue;
      stripping = false;
    }
    argv.push(token);
  }

  return argv;
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

    const argv = tokenise(segment);
    if (argv.length === 0) continue;

    switch (argv[0].toLowerCase()) {
      case 'gh':
        checkGh(argv, segment);
        break;
      case 'curl':
      case 'wget':
        checkHttp(segment);
        break;
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
