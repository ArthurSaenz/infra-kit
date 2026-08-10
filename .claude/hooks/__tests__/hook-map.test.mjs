// The guards on the guards: failures nothing else in the suite can see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOOKS_DIR, runHook, bash } from './helpers.mjs';

const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');
const SETTINGS = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));

const hookCommands = () =>
  Object.values(SETTINGS.hooks ?? {})
    .flat()
    .flatMap((matcher) => matcher.hooks ?? [])
    .map((hook) => hook.command ?? '');

// ---------------------------------------------------------------- 1. the launcher's one invariant

// The fail-closed argument is "builtins cannot fail to parse". A relative import makes that false.
test('bash-launcher.mjs has zero relative imports — the sole basis of its fail-closed guarantee', () => {
  const source = readFileSync(join(HOOKS_DIR, 'bash-launcher.mjs'), 'utf8');
  const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

  assert.ok(imports.length > 0, 'no imports found — the regex is probably wrong, not the file');

  const relative = imports.filter((spec) => spec.startsWith('.') || spec.startsWith('/'));
  assert.deepEqual(
    relative,
    [],
    `bash-launcher.mjs must import only Node builtins. A sibling module can fail to parse, and ` +
      `this file is the last thing holding the deploy lane up when that happens. Found: ${relative.join(', ')}`,
  );

  for (const spec of imports) {
    assert.match(spec, /^node:/, `expected a node: builtin, got ${JSON.stringify(spec)}`);
  }
});

// A version floor nothing else can see: below Node 24.2 `import.meta.main` is `undefined`, not an
// error, so a dispatcher gated on it never runs. bash-guard.mjs shipped that — six guards no-op,
// suite green, because these tests import the guards and never reach the gate. Comments are
// stripped first, so the fix may still name the identifier it warns about.
test('no hook gates its entrypoint on import.meta.main — undefined below Node 24.2', () => {
  const offenders = readdirSync(HOOKS_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => {
      const source = readFileSync(join(HOOKS_DIR, name), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      return /import\.meta\.main/.test(source);
    });

  assert.deepEqual(
    offenders,
    [],
    `these hooks disarm themselves on Node < 24.2: ${offenders.join(', ')}. Compare ` +
      `import.meta.url against pathToFileURL(realpathSync(process.argv[1])).href instead.`,
  );
});

// ---------------------------------------------------------------- 2. registration actually resolves

// helpers.runHook invokes hooks by path, so nothing else catches a registration pointing at nothing.
test('every hook command in settings.json resolves to a file that exists', () => {
  const missing = [];

  for (const command of hookCommands()) {
    const match = command.match(/\.claude\/hooks\/([\w.-]+\.mjs)/);
    if (!match) continue;

    const path = join(HOOKS_DIR, match[1]);
    if (!existsSync(path)) missing.push(match[1]);
  }

  assert.deepEqual(missing, [], `settings.json registers hooks that do not exist: ${missing.join(', ')}`);
});

test('the deploy lane is registered behind the launcher, not directly', () => {
  const commands = hookCommands().join('\n');

  assert.match(commands, /bash-launcher\.mjs/, 'the launcher must be the registered deploy entry');
  assert.doesNotMatch(
    commands,
    /hooks\/block-deploy\.mjs/,
    'block-deploy.mjs must run behind bash-launcher.mjs, or a parse error in it fails open again',
  );
});

// ---------------------------------------------------------------- 3. the README cannot drift

test('every hook file and every rule switch appears in the README', () => {
  const readme = readFileSync(join(HOOKS_DIR, 'README.md'), 'utf8');

  // Glob the directory, not settings.json: unregistered libraries are what would rot.
  const files = readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length >= 6, 'expected the hook directory to be populated');

  for (const file of files) {
    assert.ok(readme.includes(file), `${file} is not documented in .claude/hooks/README.md`);
  }

  const blockDeploy = readFileSync(join(HOOKS_DIR, 'block-deploy.mjs'), 'utf8');
  const switchBlock = blockDeploy.match(/const BLOCK = \{([\s\S]*?)\};/)?.[1] ?? '';
  const rules = [...switchBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.ok(rules.length >= 4, 'expected to parse the BLOCK switch');

  for (const rule of rules) {
    assert.ok(readme.includes(rule), `deploy rule "${rule}" is not documented in README.md`);
  }
});

// `ghWorkflowRun` -> `gh workflow run`: a doc escapes a key-only check by writing the human form.
const humanForm = (rule) => rule.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

// Presence cannot catch a doc that MISSTATES a rule — the error this repo actually had.
test('no doc claims a rule is blocked whose BLOCK switch is false', () => {
  const blockDeploy = readFileSync(join(HOOKS_DIR, 'block-deploy.mjs'), 'utf8');
  const switchBlock = blockDeploy.match(/const BLOCK = \{([\s\S]*?)\};/)?.[1] ?? '';
  const disarmed = [...switchBlock.matchAll(/^\s*(\w+):\s*false/gm)].map((m) => m[1]);
  assert.ok(disarmed.length > 0, 'expected at least one disarmed rule to police');

  const docs = [
    join(HOOKS_DIR, 'README.md'),
    join(REPO_ROOT, 'docs', 'agent-deploy-guard-plan.md'),
    join(REPO_ROOT, 'CLAUDE.md'),
  ].filter(existsSync);

  // Not `\boff\b`: "kick off a deploy" would satisfy that and wave the claim through.
  const SAYS_DISARMED = /\bfalse\b|switched off|is off\b|turned off|not (currently )?(refused|blocked)|disarmed/i;

  for (const rule of disarmed) {
    const spellings = [rule, humanForm(rule)];

    for (const doc of docs) {
      const text = readFileSync(doc, 'utf8');

      // EVERY matching paragraph: a correct opening then a false claim below is how this rots.
      for (const paragraph of text.split('\n\n')) {
        if (!spellings.some((spelling) => paragraph.toLowerCase().includes(spelling))) continue;

        assert.match(
          paragraph,
          SAYS_DISARMED,
          `${doc} discusses "${rule}" without recording that it is switched OFF — a reader would ` +
            `believe a disarmed rule is armed. Paragraph:\n${paragraph.slice(0, 300)}`,
        );
      }
    }
  }
});

test('no doc still claims only exit 2 blocks — the deploy guard denies via JSON on exit 0', () => {
  const docs = [join(HOOKS_DIR, 'README.md'), join(REPO_ROOT, 'docs', 'agent-deploy-guard-plan.md')].filter(
    existsSync,
  );

  for (const doc of docs) {
    assert.doesNotMatch(
      readFileSync(doc, 'utf8'),
      /Only exit 2 blocks/i,
      `${doc} repeats a false claim: block-deploy.mjs denies via permissionDecision JSON on exit 0`,
    );
  }
});

// ---------------------------------------------------------------- 4. the lane boundary holds

// Lane isolation is STATIC: the deploy lane shares no module with the advisory lane. A runtime
// version would run the second lane in a clean env, where it cannot fail for the stated reason.
test('the deploy lane imports nothing from the advisory lane', () => {
  for (const file of ['bash-launcher.mjs', 'block-deploy.mjs']) {
    const source = readFileSync(join(HOOKS_DIR, file), 'utf8');
    const specs = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

    for (const spec of specs) {
      assert.match(
        spec,
        /^node:/,
        `${file} imports ${JSON.stringify(spec)}. Every module the deploy lane loads is a file whose ` +
          `parse error takes the guard down silently at exit 1 — that is why both files are builtins-only.`,
      );
    }
  }
});

// I2: the dispatch catch-all must stay unconditional (guard-policy.test.mjs names it, asserts nothing).
test('I2: the dispatch endpoint is denied with no shell wrapper present', () => {
  const res = runHook('bash-launcher.mjs', bash('curl -X POST https://api.github.com/repos/o/r/actions/workflows/w.yml/dispatches'));

  assert.match(res.stdout, /"permissionDecision"\s*:\s*"deny"/);
  assert.doesNotMatch(res.stdout, /failed to run/, 'must deny on policy, not on a load failure');
});
