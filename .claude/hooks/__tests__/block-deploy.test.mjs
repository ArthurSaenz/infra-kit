import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHook, bash } from './helpers.mjs';

const HOOK = 'block-deploy.mjs';

// Denies via permissionDecision JSON on stdout with exit 0, so assert on the JSON, not the code.
// `reason` is exposed because a verdict alone cannot see message regressions: a branch that only
// produces a MORE SPECIFIC message than the catch-all below it looks dead to a boolean assertion.
function decision(command, opts) {
  const res = runHook(HOOK, command === null ? '{bad json' : bash(command), opts);
  let reason = '';
  try {
    reason = JSON.parse(res.stdout).hookSpecificOutput?.permissionDecisionReason ?? '';
  } catch {
    // Not a deny payload; `denied` below reports that.
  }
  return { denied: /"permissionDecision"\s*:\s*"deny"/.test(res.stdout), status: res.status, reason };
}

const HOST = 'https://api.github.com';
const PATH = 'repos/o/r/actions/workflows/w.yml/dispatches';

const BLOCKED = [
  ['gh api dispatches (space boundary)', 'gh api repos/o/r/actions/workflows/w.yml/dispatches -f ref=main'],
  ['gh api dispatches (query boundary)', 'gh api repos/o/r/actions/workflows/w.yml/dispatches?ref=main'],
  ['gh run rerun', 'gh run rerun 123'],
  ['env-prefixed gh api', 'GH_TOKEN=x gh api repos/o/r/actions/workflows/w.yml/dispatches -f x=1'],
  ['sudo-prefixed', 'sudo gh run rerun 1'],
  ['compound &&', 'echo hi && gh run rerun 1'],
  ['compound ;', 'true; gh run rerun 5'],
  ['curl to dispatches', 'curl -X POST https://api.github.com/repos/o/r/actions/workflows/w.yml/dispatches'],
  ['wget to dispatches', 'wget https://api.github.com/repos/o/r/actions/workflows/w.yml/dispatches'],
  ['ik release deliver', 'pnpm exec ik release deliver'],
  ['pnpm dx-release-deliver', 'pnpm dx-release-deliver'],
  ['ik release-deliver token', 'ik release-deliver'],
  ['node ... deliver', 'node ./bin release deliver'],
  ['mixed case', 'GH RUN RERUN 1'],
  ['tab-separated', 'gh\trun\trerun 1'],

  // RE_DISPATCH's boundary class carries quotes, so the closing `"` terminates the path.
  ['quoted URL', `gh api "${HOST}/${PATH}" -f x=1`],
  ['single-quoted URL', `gh api '${HOST}/${PATH}' -f x=1`],

  // --- shell wrappers: argv positions stop describing what runs, so phrases are matched raw ---
  ['bash -c gh run rerun', 'bash -c "gh run rerun 123"'],
  ['sh -c gh run rerun', "sh -c 'gh run rerun 123'"],
  ['zsh -c', 'zsh -c "gh run rerun 1"'],
  ['/bin/bash -c', '/bin/bash -c "gh run rerun 1"'],
  ['compound inside the payload', 'bash -c "gh run rerun 1 && pnpm build"'],
  ['nested wrapper with escaped quotes', 'bash -c "bash -c \\"gh run rerun 1\\""'],
  // Caught by checkHttp on the segment, not by the wrapper machinery — the `assembly:` rows below
  // are the real wrapper-path test.
  ['wrapped curl to dispatches (caught segment-wise)', `bash -c "curl -X POST ${HOST}/${PATH}"`],
  ['wrapped curl, single-quoted URL (caught segment-wise)', `bash -c "curl '${HOST}/${PATH}'"`],
  ['wrapped gh api dispatches', `bash -c "gh api ${PATH} -f a=1"`],
  ['wrapped dx-release-deliver', 'bash -c "pnpm dx-release-deliver"'],
  ['wrapped ik release deliver', 'bash -c "ik release deliver"'],

  // The only rows that fail if basename() stops stripping quotes.
  ['quoted wrapper token', '"bash" -c "gh run rerun 1"'],
  ['quoted prefix token', '"sudo" gh run rerun 1'],

  // --- assembled endpoint: the split puts host and path in different segments ---
  ['assembly: host in a variable', `bash -c 'H=${HOST}; curl "$H/${PATH}"'`],
  ['assembly: host + prefix in a variable', `bash -c 'H=${HOST}/repos/o/r; curl "$H/actions/workflows/w.yml/dispatches"'`],
  ['assembly: path in a variable (pins `;` in the boundary class — allows without it)', `bash -c 'P=/${PATH}; curl "${HOST}$P"'`],

  // --- any-token gate: a value-taking prefix leaves its value at argv[0], disarming a head gate ---
  ['timeout + wrapper', 'timeout 60 bash -c "gh run rerun 1"'],
  ['env -i + wrapper', 'env -i bash -c "gh run rerun 1"'],
  ['nice -n + wrapper', 'nice -n 10 bash -c "gh run rerun 1"'],
  ['stdbuf + wrapper', 'stdbuf -oL bash -c "gh run rerun 1"'],
  ['xargs -I + wrapper', 'xargs -I{} bash -c "gh run rerun 1"'],
  ['timeout + sh -c deliver', 'timeout 60 sh -c "pnpm dx-release-deliver"'],

  // --- paths: argv[0] is a path, so an exact-name match misses ---
  ['absolute path to gh', '/opt/homebrew/bin/gh run rerun 1'],
  ['relative path to gh', './bin/gh run rerun 7'],
  ['absolute path to ik', '/usr/local/bin/ik release deliver'],
  ['absolute path to the deliver binary', '/usr/local/bin/dx-release-deliver'],
  ['bare dx-release-deliver as argv[0]', 'dx-release-deliver'],
  ['release-deliver as argv[0]', 'release-deliver'],

  // Wrapped AND path-qualified: RE_RAW_DELIVER_PREFIXED is the only check here, and its lookbehind
  // once included `/`, so the path separator let prod delivery through.
  ['wrapped absolute path to the deliver binary', 'bash -c "/usr/local/bin/dx-release-deliver"'],
  ['wrapped relative path to a deliver script', 'bash -c "./scripts/dx-release-deliver"'],
  ['sh -c with a path-qualified deliver', 'sh -c "/opt/bin/release-deliver"'],

  // --- prefix commands: stripped so the real command reaches argv[0] ---
  ['env gh', 'env gh run rerun 1'],
  ['/usr/bin/env gh', '/usr/bin/env gh run rerun 1'],
  ['env assign + gh api dispatches', `env GH_TOKEN=x gh api ${PATH} -f a=1`],
  ['command gh', 'command gh run rerun 1'],
  ['exec gh', 'exec gh run rerun 1'],
  ['eval gh', 'eval gh run rerun 1'],
  ['nohup gh', 'nohup gh run rerun 1'],
  ['xargs gh via pipe', 'echo x | xargs gh run rerun'],
  ['sudo + env + path', 'sudo env GH_TOKEN=x /opt/homebrew/bin/gh run rerun 1'],

  // --- one row per SHELL_WRAPPERS member beyond bash/sh/zsh ---
  // Each member is load-bearing alone: deleting `dash` from the set left the whole suite green.
  ['dash -c', 'dash -c "gh run rerun 1"'],
  ['ksh -c', 'ksh -c "gh run rerun 1"'],
  ['fish -c', 'fish -c "gh run rerun 1"'],
  ['csh -c', 'csh -c "gh run rerun 1"'],
  ['tcsh -c', 'tcsh -c "gh run rerun 1"'],

  // --- prefixes with NO wrapper present ---
  // The `+ wrapper` rows above cannot test the prefix: with the prefix deleted, the wrapper scan
  // still denies, so the row passes either way. `stdbuf` was covered only in that useless shape.
  ['doas, no wrapper', 'doas gh run rerun 1'],
  ['builtin, no wrapper', 'builtin gh run rerun 1'],
  ['stdbuf with a value flag, no wrapper', 'stdbuf -oL gh run rerun 1'],

  // --- every dispatch-switch head that routes to checkInfraKit ---
  // `pnpm exec infra-kit …` is headed by `pnpm`, so the `infra-kit` case — and GUARDED_TOOLS'
  // `infra-kit` entry — were never reached. A bare `deliver` needs the tool beside it, which is
  // exactly what these heads supply.
  ['bare infra-kit as argv[0]', 'infra-kit release deliver'],

  // GUARDED_TOOLS is read ONLY by the re-anchor, which runs when a value-taking prefix consumed
  // tokens and may have eaten the tool itself. `script --command "ik …"` above covers `ik`;
  // `infra-kit` reached that path untested, since every other row puts it at argv[0] or after `pnpm`.
  ['flock -c payload naming infra-kit', 'flock -c "infra-kit release deliver" /tmp/l'],
  ['npm head', 'npm release deliver'],
  ['npx head', 'npx release deliver'],
  ['pnpx head', 'pnpx release deliver'],
  ['yarn head', 'yarn release deliver'],
];

// The raw scan reads the WHOLE command, so a wrapper anywhere re-arms the phrase everywhere. These
// over-block, accepted: scoping the scan to the wrapper's segment fails OPEN instead.
const BLOCKED_ACCEPTED_FALSE_DENIES = [
  ['phrase quoted inside a payload', `bash -c "echo 'gh run rerun'"`],
  ['wrapper in one segment, phrase in another', 'bash script.sh && grep "gh run rerun" f'],
  ['shell named as a noun + phrase elsewhere', 'ls /bin/bash && grep "gh run rerun" f'],
  ['unrelated path containing /dispatches', 'bash -c "cat /var/log/dispatches/x"'],
  // checkHttp is command-wide now too, so two independent searches that between them mention the
  // host and the path read as one assembled call. Contrived, and the fail-closed direction —
  // recorded here so it is not filed as a bug later. Either search ALONE still allows.
  ['two searches that together name host and path', 'rg api.github.com docs/ && rg "/dispatches" docs/'],
];

const ALLOWED = [
  ['gh run list', 'gh run list'],
  ['gh run view', 'gh run view 1'],
  ['gh workflow view', 'gh workflow view w'],
  ['substring in grep arg', 'grep "gh run rerun" file.txt'],
  ['deploy-all is allowed', 'pnpm exec ik release deploy-all'],
  ['plain build', 'pnpm run build'],
  ['dispatches in a non-gh command', 'ls dispatches/'],

  // --- reads stay open inside a wrapper too ---
  ['wrapped gh run list', 'bash -c "gh run list"'],
  ['wrapped gh workflow view', 'bash -c "gh workflow view w"'],
  // These two pin the RE_RAW_GH_API && RE_DISPATCH conjunction. Dropping the AND is the most
  // likely implementation error, and it would deny a read CLAUDE.md explicitly blesses.
  ['wrapped gh api, non-dispatch', 'bash -c "gh api repos/o/r"'],
  ['wrapped gh api user', 'bash -c "gh api user"'],
  ['wrapped build', 'bash -c "pnpm run build"'],
  ['wrapped deploy-all', 'bash -c "pnpm exec ik release deploy-all"'],

  ['bash script.sh — the file is never read', 'bash script.sh'],
  ['sh -x script', 'sh -x scripts/notes.sh'],
  ['path to gh, read verb', '/opt/homebrew/bin/gh run list'],
  ['env assignment + test', 'env NODE_ENV=test pnpm test'],
  ['time + build', 'time pnpm run build'],
  ['ls the gh binary', 'ls /opt/homebrew/bin/gh'],
  ['assignment-only segment must not fail closed', 'FOO=bar && pnpm test'],
  ['which bash', 'which bash'],
  ['echo bash', 'echo bash'],
  ['shell as a filename, phrase in another segment', 'cat bash-notes.txt && grep "gh run rerun" f'],
  ['command -v', 'command -v pnpm'],
  ['dispatches without a leading slash + wrapper', 'rg dispatches . && bash x.sh'],
];

// One theory of "deliver" across all three call sites: a dx-/release- prefixed name counts
// anywhere, a bare `deliver` needs an infra-kit tool beside it. Without that, adding a wrapper
// could turn a denied execution into an allowed one.
const ALLOWED_DELIVER_BOUNDARY = [
  ['bare scripts/deliver', 'scripts/deliver'],
  ['wrapped scripts/deliver', 'bash -c "scripts/deliver x"'],
  ['sh scripts/deliver', 'sh scripts/deliver'],
  ['deliver as English in a commit message', 'bash -c "git commit -m \\"feat: deliver emails\\""'],
  ['rg deliver + a wrapper elsewhere', 'rg deliver .omc/plans/ && bash scripts/x.sh'],
  ['which bash + rg deliver', 'which bash && rg deliver .'],
  ['quote-boundary coherence', 'git commit -m "pin bash " && rg deliver .'],
];

// A value-taking prefix with NO shell wrapper — the `+ wrapper` rows above only proved the wrapper
// path. Option flags are what bare arity misses (`script -q /dev/null gh ...` leaves `-q`).
const PREFIX_BYPASS = [
  ['timeout', 'timeout 60 gh run rerun 123'],
  ['setsid', 'setsid gh run rerun 123'],
  ['flock', 'flock /tmp/l gh run rerun 123'],
  ['script', 'script -q /dev/null gh run rerun 123'],
  ['watch', 'watch gh run rerun 123'],
  ['timeout + rerun', 'timeout 60 gh run rerun 123'],
  ['timeout + ik deliver', 'timeout 60 ik release deliver'],
  ['nice with a value flag', 'nice -n 10 gh run rerun 1'],
  ['timeout with -k and a duration', 'timeout -k 5 60 gh run rerun 1'],
  ['flock with a bare flag', 'flock -n /tmp/l gh run rerun 1'],
  // sudo takes `-u <user>`, so without a spec its value lands at argv[0] just like timeout's.
  ['sudo with a detached user value', 'sudo -u root gh run rerun 1'],

  // Payload form: `-c` is not in flock's/script's valueOpts, so the option loop eats it and the
  // positional value swallows the payload's opening quote — leaving an ordinary word at argv[0].
  // Pins the re-anchor, which must search the original tokens rather than argv.
  ['flock -c payload', 'flock -c "gh run rerun 123" /tmp/l'],
  ['script -c payload', 'script -c "gh run rerun 1" /dev/null'],
  ['script --command payload', 'script --command "ik release deliver" /dev/null'],

  // checkGh read argv[1]/argv[2] raw while argv[0] used basename().
  ['quoted gh subcommand', 'gh "run" rerun 123'],
  ['quoted gh object', "gh run 'rerun' 123"],
];

// The splitter is quote-blind, so a `|` inside a quoted regex makes a segment headed by
// `timeout`/`script`/`flock`, which then consumes a value and fails closed on ordinary work.
const SPLIT_ARTEFACTS_AND_WRAPPERS = [
  ['alternation containing a prefix name', 'rg -n "fatal|timeout" .claude/hooks/'],
  ['alternation containing script', 'rg "hook|script" package.json'],
  ['alternation containing flock', 'rg -n "mutex|flock" src/lib.ts'],
  ['test filter with an alternation', 'pnpm test -- --grep "retry|timeout"'],
  ['flock guarding an ordinary build', 'flock /tmp/build.lock -c "pnpm build"'],
  ['flock with a wait and a lockfile', 'flock -w 5 /var/lock/x -c "pnpm build"'],
  ['timeout with a -- separator', 'timeout 30 -- pnpm test'],
  ['sudo credential refresh', 'sudo -v'],
];

test('block-deploy allows split artefacts and ordinary wrapper usage', () => {
  for (const [label, command] of SPLIT_ARTEFACTS_AND_WRAPPERS) {
    assert.equal(decision(command).denied, false, `should allow: ${label} — ${command}`);
  }
});

// The obvious fix — "unrecognised head plus a later `gh` token" — denies every one of these, since
// `git`/`rg`/`echo` are all unrecognised. They are how the fix itself gets written and rolled back.
const EXECUTOR_CORPUS = [
  ['commit message naming the fix', 'git commit -m "fix: timeout gh run rerun now denies"'],
  ['grep for the guarded phrase', 'rg "gh run rerun" .claude/hooks/'],
  ['log search for deliver', 'git log --oneline | rg -i deliver'],
  ['rollback', 'git revert --no-edit abc1234'],
  ['the suite itself', 'pnpm run test:claude'],
  ['env assignment before an ordinary command', 'env MSG=x git commit -m "note gh run rerun"'],
];

// C2 / I2: the catch-all lived inside checkRawShell, so it ran only when a wrapper was present,
// while checkHttp needs host and path in the SAME segment. A variable splits them apart.
const ASSEMBLED_NO_WRAPPER = [
  ['host in a variable, no wrapper anywhere', `A=${HOST} ; curl -X POST $A/${PATH}`],
  ['host + prefix in a variable, no wrapper', `A=${HOST}/repos/o/r ; curl "$A/actions/workflows/w.yml/dispatches"`],
];

// C3: checkInfraKit scanned every token after argv[0] for a bare `deliver`, so any command under
// an infra-tool head that mentioned the word was denied. guard-policy.test.mjs measures it as
// ordinary vocabulary here, which is why the bare token cannot deny alone.
const ORDINARY_DELIVER = [
  ['search', 'pnpm exec rg deliver src/'],
  ['test filter', 'pnpm test -- --grep deliver'],
  ['script argument', 'node scripts/build.js deliver'],
  ['a package actually named deliver', 'pnpm add deliver'],
];

// The conjunction must still catch the real thing by BOTH routes: the positional sequence, and a
// self-identifying prefixed name. Neither alone suffices — see RE_DELIVER_HEAD's own note.
const REAL_DELIVER = [
  ['ik release deliver', 'ik release deliver'],
  ['infra-kit spelled out', 'pnpm exec infra-kit release deliver'],
  ['prefixed script name', 'pnpm dx-release-deliver'],
  ['prefixed via run', 'pnpm run dx-release-deliver'],
  ['behind a value-taking prefix', 'timeout 60 ik release deliver'],
];

test('block-deploy allows ordinary commands that merely mention deliver', () => {
  for (const [label, command] of ORDINARY_DELIVER) {
    assert.equal(decision(command).denied, false, `should allow: ${label} — ${command}`);
  }
});

test('block-deploy still denies a real delivery, by both routes', () => {
  for (const [label, command] of REAL_DELIVER) {
    assert.ok(decision(command).denied, `should deny: ${label} — ${command}`);
  }
});

test('block-deploy denies an assembled dispatch endpoint with no shell wrapper present', () => {
  for (const [label, command] of ASSEMBLED_NO_WRAPPER) {
    assert.ok(decision(command).denied, `should deny: ${label} — ${command}`);
  }
});

// The conjunction keeps the fix from locking the room it is in: only the token TOGETHER WITH the
// host means execution.
test('block-deploy still allows searching for the dispatch token alone', () => {
  for (const command of ['rg "/dispatches" .claude/', 'ls dispatches/', 'grep -rn /dispatches docs/']) {
    assert.equal(decision(command).denied, false, `should allow: ${command}`);
  }
});

test('block-deploy denies a guarded command behind a value-taking prefix (no wrapper)', () => {
  for (const [label, command] of PREFIX_BYPASS) {
    assert.ok(decision(command).denied, `should deny: ${label} — ${command}`);
  }
});

test('block-deploy allows ordinary commands that merely name a guarded token', () => {
  for (const [label, command] of EXECUTOR_CORPUS) {
    assert.equal(decision(command).denied, false, `should allow: ${label} — ${command}`);
  }
});

test('block-deploy DENIES every bypass via permissionDecision (exit 0 + deny JSON)', () => {
  for (const [label, command] of BLOCKED) {
    const d = decision(command);
    assert.ok(d.denied, `should deny: ${label}`);
    assert.equal(d.status, 0, `deny must exit 0 (JSON channel): ${label}`);
  }
});

test('block-deploy over-blocks these, knowingly (raw scan is command-wide)', () => {
  for (const [label, command] of BLOCKED_ACCEPTED_FALSE_DENIES) {
    const d = decision(command);
    assert.ok(d.denied, `accepted false deny should deny: ${label}`);
    assert.equal(d.status, 0, label);
  }
});

test('block-deploy allows read paths and non-deploy commands (no deny)', () => {
  for (const [label, command] of ALLOWED) {
    const d = decision(command);
    assert.equal(d.denied, false, `should allow: ${label}`);
    assert.equal(d.status, 0, label);
  }
});

test('block-deploy applies one consistent theory of "deliver" (bare vs self-identifying)', () => {
  for (const [label, command] of ALLOWED_DELIVER_BOUNDARY) {
    const d = decision(command);
    assert.equal(d.denied, false, `should allow: ${label}`);
    assert.equal(d.status, 0, label);
  }
});

test('block-deploy fails closed when prefix stripping consumes the whole command', () => {
  // Accepted cost: the bare-prefix family fail-closes, so `env | grep DOPPLER` denies.
  for (const command of [
    // Only prefixes that DO something on their own. `timeout`/`flock`/`script`/`watch`/`setsid`
    // with no operand run nothing, and the quote-blind splitter manufactures exactly that shape
    // from `rg "fatal|timeout" x` — see SPLIT_ARTEFACTS_AND_WRAPPERS.
    'echo x | xargs', 'env | grep DOPPLER', 'env | sort', 'env', 'time', 'sudo',
    // The rest of BARE_PREFIX_FAILS_CLOSED. Each was removable from the set with a green suite:
    // `env`/`time`/`sudo`/`xargs` above were the only members this test ever pinned.
    'doas', 'command', 'builtin', 'exec', 'eval', 'nohup', 'nice', 'stdbuf',
  ]) {
    assert.ok(decision(command).denied, `stripped-to-empty must deny, never silently pass: ${command}`);
  }
});

// `ghWorkflowRun` is switched OFF in BLOCK, so these are ALLOWED today. Asserting that is the honest
// alternative to an env var re-arming the switch behind the suite's back: the tests describe the
// shipped configuration. Arming the rule moves these rows into BLOCKED, and this test failing is
// the reminder to move them. The mechanisms they used to cover — prefix stripping, wrappers, paths —
// are exercised throughout BLOCKED via `gh run rerun`, which is armed, so nothing is lost.
const DISARMED_GH_WORKFLOW_RUN = [
  'gh workflow run deploy.yml',
  'sudo gh workflow run x',
  'timeout 60 gh workflow run x',
  '/opt/homebrew/bin/gh workflow run x',
];

test('the disarmed ghWorkflowRun rule really is disarmed — the suite tracks config, not intent', () => {
  for (const command of DISARMED_GH_WORKFLOW_RUN) {
    assert.equal(
      decision(command).denied,
      false,
      `expected allowed while BLOCK.ghWorkflowRun is false: ${command}`,
    );
  }
});

// Boolean assertions make a branch whose only contribution is a better MESSAGE look dead — the
// `gh api` arm is verdict-identical to the catch-all below it, and was nearly deleted for that.
const MESSAGES = [
  ['gh run rerun 123', /re-executes a previous run, deploy runs included/],
  [`gh api ${PATH} -f ref=main`, /POSTs implicitly/],
  [`bash -c "gh api ${PATH} -f a=1"`, /`gh api` against the workflow-dispatch endpoint inside a shell wrapper/],
  [`bash -c "gh run rerun 1"`, /inside a shell wrapper — re-executes a previous run/],
  [`curl -X POST ${HOST}/${PATH}`, /direct HTTP call to the workflow-dispatch endpoint/],
  ['ik release deliver', /merges the release PR into main and deploys prod/],
  ['dx-release-deliver', /is infra-kit's delivery entrypoint/],
  ['env', /failing closed/],
];

test('block-deploy names the specific rule it denied on, not just "denied"', () => {
  for (const [command, expected] of MESSAGES) {
    const d = decision(command);
    assert.ok(d.denied, `precondition: must deny — ${command}`);
    assert.match(d.reason, expected, `wrong or degraded message for: ${command}`);
  }
});

// The deny text is the only thing the agent sees, so it must carry the way out, not just the refusal.
test('every deny message points at the sanctioned alternative', () => {
  const d = decision('gh run rerun 123');
  assert.match(d.reason, /mcp__infra-kit__gh-release-deploy-all/, 'must name the MCP tool');
  assert.match(d.reason, /pnpm exec infra-kit release-deploy-all/, 'and the CLI equivalent');
  assert.match(d.reason, /gh run list/, 'and say which reads stay allowed');
});

test('block-deploy fails closed on malformed / empty / missing tool_name (deny JSON)', () => {
  assert.ok(decision(null).denied, 'malformed → deny');
  assert.ok(runHook(HOOK, '').stdout.includes('deny'), 'empty stdin → deny');
  assert.ok(runHook(HOOK, { tool_name: '' }).stdout.includes('deny'), 'missing tool_name → deny');
});

test('block-deploy ignores non-Bash tools and empty commands (no deny, exit 0)', () => {
  const read = runHook(HOOK, { tool_name: 'Read', tool_input: {} });
  assert.equal(/permissionDecision/.test(read.stdout), false);
  assert.equal(read.status, 0);
  const empty = runHook(HOOK, { tool_name: 'Bash', tool_input: {} });
  assert.equal(/permissionDecision/.test(empty.stdout), false);
  assert.equal(empty.status, 0);
});

// Aimed at block-deploy.mjs DIRECTLY, never at "whatever settings.json registers as the deploy
// entry" — those differ now that bash-launcher.mjs fronts this guard. chmodStrip copies the hook
// alone into a tmpdir; a launcher copied that way cannot find its guard and denies on the
// load-failure path, which would satisfy a boolean-only assertion while exercising no policy at
// all. Matching `reason` is what keeps this test about the deploy rules.
test('block-deploy is mode-independent (denies on POLICY even with the exec bit stripped)', () => {
  const d = decision('gh api repos/o/r/actions/workflows/w.yml/dispatches -f ref=main', {
    chmodStrip: true,
  });

  assert.ok(d.denied);
  assert.match(d.reason, /BLOCKED by deploy guard/);
  assert.doesNotMatch(d.reason, /failed to run|failing closed/);
});
