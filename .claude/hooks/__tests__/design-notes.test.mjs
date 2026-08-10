// The README's `## Design notes` hold rationale that used to live beside the code. Moving it out
// spent the one property a comment has for free — being seen by whoever edits that line. This is
// the partial refund: every note must point back at a real file and a reachable line, so a note
// about deleted code fails the suite instead of quietly describing something that is gone.
//
// It does NOT pin that the prose is still TRUE — no test can. That limit is the same one the rest
// of this README carries, and it is why invariants stayed inline rather than moving here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HOOKS_DIR } from './helpers.mjs';

const README = readFileSync(join(HOOKS_DIR, 'README.md'), 'utf8');

// The `## Design notes` body: from that heading to the next `## `, or to EOF.
function designNotesBody() {
  const start = README.indexOf('\n## Design notes');
  if (start === -1) return null;
  const rest = README.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

// `path.mjs:123` — the path may carry directories (`__tests__/x.test.mjs`). Built per call rather
// than shared: one `/g` regex reused across `.test()` and `.matchAll()` carries `lastIndex` between
// them and starts skipping matches.
const citations = (text) => [...text.matchAll(/([\w./-]+\.mjs):(\d+)/g)];

test('the README has a Design notes section', () => {
  assert.ok(designNotesBody(), 'expected a `## Design notes` heading in .claude/hooks/README.md');
});

test('every Design notes subsection cites a source line', () => {
  const body = designNotesBody();
  const subsections = body.split(/\n### /).slice(1);

  assert.ok(subsections.length > 0, 'expected at least one `###` subsection under Design notes');

  const uncited = subsections
    .filter((section) => citations(section).length === 0)
    .map((section) => section.split('\n')[0]);

  assert.deepEqual(
    uncited,
    [],
    `Design notes subsections with no \`file.mjs:line\` citation: ${uncited.join(' | ')}. ` +
      `A note nobody can trace back to code is how this section rots.`,
  );
});

// A hook comment that says "see README `## X`" is a pointer with no compiler behind it. Rename the
// heading and the code's only route to that explanation dangles, silently. Same class of rot the
// citations above guard, one direction out.
test('every README heading a hook source points at still exists', () => {
  const dangling = [];

  for (const file of readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.mjs'))) {
    const source = readFileSync(join(HOOKS_DIR, file), 'utf8');

    // Prefix match on the heading LINE: a reference names the section, while the heading itself
    // often carries a suffix (`## Deploy rules — \`block-deploy.mjs\``). Requiring an exact match
    // would fail on a correct pointer.
    for (const [, heading] of source.matchAll(/README\s+`(##+ [^`]+)`/g)) {
      const found = README.split('\n').some((line) => line.startsWith(heading));
      if (!found) dangling.push(`${file} -> ${heading}`);
    }

    // The unbackticked spelling used by the relocated passages.
    if (/see README Design notes/.test(source) && !README.includes('\n## Design notes\n')) {
      dangling.push(`${file} -> ## Design notes`);
    }
  }

  assert.deepEqual(dangling, [], `hook comments pointing at README headings that do not exist:\n  ${dangling.join('\n  ')}`);
});

test('every cited file exists and is long enough for the cited line', () => {
  const body = designNotesBody();
  const problems = [];

  for (const [, file, line] of citations(body)) {
    const path = join(HOOKS_DIR, file);

    if (!existsSync(path)) {
      problems.push(`${file}:${line} — no such file`);
      continue;
    }

    const lines = readFileSync(path, 'utf8').split('\n').length;
    if (Number(line) > lines) problems.push(`${file}:${line} — file has only ${lines} lines`);
  }

  assert.deepEqual(problems, [], `broken Design notes citations:\n  ${problems.join('\n  ')}`);
});
