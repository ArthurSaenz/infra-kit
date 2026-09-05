#!/usr/bin/env node
// Blocks agent-initiated deployments; reads stay allowed. A tripwire, not a wall — the real control
// is server-side. Self-contained, so no sibling-hook bug or stripped exec bit turns a block into a
// silent pass. Denies via permissionDecision JSON, which holds under bypassPermissions.
//
// Gaps: `bash script.sh`, `$(which gh)`, aliases, a tool named via a variable, and any prefix
// missing from PREFIX_COMMANDS — unstripped, its own name sits at argv[0].

import { readFileSync } from 'node:fs';

// Any HTTP method, since `gh api` POSTs implicitly on -f/-F. The boundary class carries quotes and
// shell operators so an assembled URL still matches; the leading `/` keeps `ls dispatches/` out.
const RE_DISPATCH = /\/dispatches([/?"';&|]|\s|$)/i;
const RE_GITHUB_API = /api\.github\.com/i;
const RE_ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Matched ANYWHERE in a segment: a value-taking prefix leaves its own value at argv[0].
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);

// Stripped so the real command reaches argv[0]. An omission is a bypass — `timeout` was once missing.
const PREFIX_COMMANDS = new Set([
  'sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'eval', 'nohup', 'nice', 'stdbuf', 'time', 'xargs',
  'timeout', 'setsid', 'flock', 'script', 'watch',
]);

// What each prefix eats. Bare arity is not enough — option flags leave residue (`nice -n 10`).
const PREFIX_SPECS = {
  sudo: { valueOpts: ['-u', '--user', '-g', '--group', '-p', '--prompt'], values: 0 },
  timeout: { valueOpts: ['-k', '--kill-after', '-s', '--signal'], values: 1 },
  nice: { valueOpts: ['-n', '--adjustment'], values: 0 },
  flock: { valueOpts: ['-w', '--timeout', '-E', '--conflict-exit-code'], values: 1 },
  script: { valueOpts: ['-c', '--command'], values: 1 },
  watch: { valueOpts: ['-n', '--interval'], values: 0 },
  xargs: { valueOpts: ['-n', '-P', '-I'], values: 0 },
  stdbuf: { valueOpts: ['-i', '-o', '-e'], values: 0 },
  env: { valueOpts: ['-u', '--unset'], values: 0 },
};

// Only prefixes that DO something alone (bare `env` prints the environment). Bare `timeout`/`flock`
// run nothing, and the quote-blind splitter manufactures exactly that from `rg "fatal|timeout" x`.
const BARE_PREFIX_FAILS_CLOSED = new Set([
  'sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'eval', 'nohup', 'nice', 'stdbuf', 'time', 'xargs',
]);

// Keyed on the TOOL, never "unrecognised head" — that would deny `git commit -m "…gh workflow run…"`.
const GUARDED_TOOLS = new Set(['gh', 'ik', 'infra-kit']);

// Used ONLY when a shell wrapper is present — see checkRawShell.
const RE_RAW_WF_RUN = /\bgh\s+workflow\s+run\b/i;
const RE_RAW_RERUN = /\bgh\s+run\s+rerun\b/i;
const RE_RAW_GH_API = /\bgh\s+api\b/i; // MUST be ANDed with RE_DISPATCH — `gh api` alone is a read.

// Self-identifying, so it may match after a `/`. The lookbehind omits `/` on purpose: with it,
// `bash -c "/usr/bin/dx-release-deliver"` matched nothing, since inside a wrapper this is the only
// check. Cost is over-blocking a path ending in the name — the fail-closed direction.
const RE_RAW_DELIVER_PREFIXED = /(?<![\w-])(dx-|release-)(release-)?deliver(?![\w/-])/i;

// KEEPS its `/`: `deliver` is ordinary vocabulary here, so matching `src/deliver/` would deny
// `pnpm exec rg x src/deliver/`. A bare one therefore needs an infra-kit tool beside it.
const RE_BARE_DELIVER = /(?<![\w/-])deliver(?![\w/-])/i;
const RE_INFRA_TOOL = /\b(ik|infra-kit|pnpm|npm|npx|pnpx|yarn|node)\b/i;

// Self-identifying names only. One of checkInfraKit's two routes — never the only one.
const RE_DELIVER_HEAD = /^(dx-|release-)(release-)?deliver$/i;

// The switch: flip a line to open a rule. Delivery is deliberately absent, so no line opens prod.
// How this layer relates to settings.json's `permissions.deny` — see README `## Deploy rules`.
const BLOCK = {
  ghWorkflowRun: false,
  ghRunRerun: true,
  ghApiDispatch: true,
  httpDispatch: true,
};

// exit 0, because the JSON channel is only read on exit 0. `reason` is surfaced to the model.
const denyDecision = (reason) => {
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
};

const failClosed = (reason) => {
  denyDecision(`block-deploy: ${reason} — failing closed.`);
};

const deny = (reason) => {
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
};

// Two-char operators before their single-char prefixes.
const splitIntoSegments = (text) => {
  return text
    .replaceAll('&&', '\n')
    .replaceAll('||', '\n')
    .replaceAll(';', '\n')
    .replaceAll('|', '\n')
    .replaceAll('&', '\n')
    .split('\n');
};

// Dependency-free. Quotes go first, so `bash"` and `bash` reach the same verdict.
const basename = (token) => {
  const unquoted = token.replace(/^["']+|["']+$/g, '');
  return unquoted.slice(unquoted.lastIndexOf('/') + 1).toLowerCase();
};

// Without this, argv[0] is "GH_TOKEN=x" or "env" and every check misses. `lastPrefix` names the
// prefix that was stripped, so an all-prefix segment can fail closed on it. Assignments do not set
// it — `FOO=bar && pnpm test` is benign.
const tokenise = (segment) => {
  const raw = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  let consumedValues = false;
  let lastPrefix = null;

  while (i < raw.length) {
    if (RE_ENV_ASSIGN.test(raw[i])) {
      i += 1;
      continue;
    }

    const name = basename(raw[i]);
    if (!PREFIX_COMMANDS.has(name)) break;

    lastPrefix = name;
    i += 1;

    const spec = PREFIX_SPECS[name];
    if (!spec) continue;

    const before = i;

    // Only a DETACHED value is skipped; `-I{}` carries its own.
    while (i < raw.length && raw[i].startsWith('-')) {
      const takesValue = spec.valueOpts.includes(raw[i]);
      i += 1;
      if (takesValue && i < raw.length) i += 1;
    }

    for (let consumed = 0; consumed < spec.values && i < raw.length; consumed += 1) i += 1;

    // ACTUAL consumption, not just "has a spec": bare `env` must still fail closed.
    if (i > before) consumedValues = true;
  }

  const argv = raw.slice(i);

  // Spec mis-modelled the prefix, so re-anchor on a guarded tool in the ORIGINAL tokens — a
  // mis-parse can eat the tool itself (`flock -c "gh …"` consumes `"gh`).
  if (consumedValues) {
    const at = raw.findIndex((token, index) => index > 0 && GUARDED_TOOLS.has(basename(token)));
    if (at !== -1) return { argv: raw.slice(at), consumedValues, lastPrefix };
  }

  return { argv, consumedValues, lastPrefix };
};

// Positional, never substring: `gh run rerun` re-runs a deploy, `gh run list` reads.
const checkGh = (argv, segment) => {
  // basename(), as argv[0] already does — a raw read lets `gh "workflow" run x` walk past.
  const verb = basename(argv[1] ?? '');
  const object = basename(argv[2] ?? '');

  if (BLOCK.ghWorkflowRun && verb === 'workflow' && object === 'run') {
    deny('`gh workflow run` bypasses infra-kit and dispatches a workflow directly.');
  }
  if (BLOCK.ghRunRerun && verb === 'run' && object === 'rerun') {
    deny('`gh run rerun` re-executes a previous run, deploy runs included.');
  }
  if (BLOCK.ghApiDispatch && verb === 'api' && RE_DISPATCH.test(segment)) {
    deny('`gh api` against the workflow-dispatch endpoint (it POSTs implicitly on -f/-F).');
  }
};

// The same endpoint with no `gh` in sight.
const checkHttp = (segment) => {
  if (BLOCK.httpDispatch && RE_GITHUB_API.test(segment) && RE_DISPATCH.test(segment)) {
    deny('direct HTTP call to the workflow-dispatch endpoint (bypasses every gh rule).');
  }
};

// Two routes, and BOTH are needed: the prefixed name alone fails open on `ik release deliver`, the
// positional sequence alone misses `pnpm dx-release-deliver`.
const checkInfraKit = (argv) => {
  const rest = argv.slice(1);

  const prefixed = rest.find((token) => RE_DELIVER_HEAD.test(basename(token)));
  if (prefixed) {
    deny(
      `\`${prefixed}\` merges the release PR into main and deploys prod — irreversible, and a human's call.`,
    );
  }

  // The SEQUENCE, not two loose tokens: `rg release src/ && rg deliver src/` must stay a search.
  const at = rest.findIndex((token) => basename(token) === 'release');
  if (at !== -1 && rest[at + 1] !== undefined && basename(rest[at + 1]) === 'deliver') {
    deny(
      "`release deliver` merges the release PR into main and deploys prod — irreversible, and a human's call.",
    );
  }
};

// argv positions are meaningless once a wrapper is present, and recursing into the `-c` payload
// fails OPEN because splitIntoSegments is quote-blind. Matching the ORIGINAL string over-blocks
// instead: a false deny announces itself, a false allow is silent.
const checkRawShell = (command) => {
  if (BLOCK.ghWorkflowRun && RE_RAW_WF_RUN.test(command)) {
    deny('`gh workflow run` inside a shell wrapper — dispatches a workflow directly, bypassing infra-kit.');
  }
  if (BLOCK.ghRunRerun && RE_RAW_RERUN.test(command)) {
    deny('`gh run rerun` inside a shell wrapper — re-executes a previous run, deploy runs included.');
  }
  // ANDed, else `gh api repos/o/r` would deny. Subsumed by the catch-all below; it survives only to
  // name the rule the model sees.
  if (BLOCK.ghApiDispatch && RE_RAW_GH_API.test(command) && RE_DISPATCH.test(command)) {
    deny('`gh api` against the workflow-dispatch endpoint inside a shell wrapper.');
  }
  if (RE_RAW_DELIVER_PREFIXED.test(command) || hasBareDeliverWithTool(command)) {
    deny(
      "a `deliver` command inside a shell wrapper — delivery merges the release PR into main and deploys prod, a human's call.",
    );
  }
  // Catches an endpoint assembled across segments, which checkHttp never sees whole.
  if (BLOCK.httpDispatch && RE_DISPATCH.test(command)) {
    deny('the workflow-dispatch endpoint appears inside a shell wrapper — this hook is the only guard on that endpoint.');
  }
};

// Segment-scoped: command-wide would match `rg deliver . && pnpm build`.
const hasBareDeliverWithTool = (command) => {
  return splitIntoSegments(command).some(
    (segment) => RE_BARE_DELIVER.test(segment) && RE_INFRA_TOOL.test(segment),
  );
};

// An uncaught error exits non-zero-but-not-2, which does NOT block.
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

  // UNCONDITIONAL: nested in checkRawShell it ran only when a wrapper happened to be present, and a
  // host assembled via a variable splits away from the path. Host AND path — a bare token would
  // block searching for it.
  checkHttp(command);

  for (const segment of splitIntoSegments(command)) {
    if (!segment.trim()) continue;

    const { argv, consumedValues, lastPrefix } = tokenise(segment);

    // Bare prefixes all the way down (`env`, `time`): we cannot say what would have run. Not when
    // values were consumed first — then nothing would have run, which is the shape the quote-blind
    // splitter makes from `rg -n "fatal|timeout" x`.
    if (argv.length === 0) {
      if (!consumedValues && BARE_PREFIX_FAILS_CLOSED.has(lastPrefix)) {
        failClosed('command consumed entirely by prefix stripping');
      }
      continue;
    }

    const head = basename(argv[0]);

    if (RE_DELIVER_HEAD.test(head)) {
      deny(
        `\`${argv[0]}\` is infra-kit's delivery entrypoint — it merges the release PR into main and deploys prod. Irreversible, and a human's call.`,
      );
    }

    // The `continue` skips the positional gh checks — the quoted-argv[0] gap listed at the top.
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
