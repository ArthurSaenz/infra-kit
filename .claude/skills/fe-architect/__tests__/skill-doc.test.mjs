/**
 * Pins SKILL.md to the files it points at, so the reference index cannot drift
 * away from the references, and so the two frontend skills cannot disagree
 * about a threshold again.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { SKILL_DIR } from './helpers.mjs';

const PATTERNS_DIR = join(SKILL_DIR, '..', 'fe-patterns');
const skillMd = () => readFile(join(SKILL_DIR, 'SKILL.md'), 'utf-8');

/** Every `[label](./path)` or `[label](../path)` link in a markdown document. */
const links = (md) => [...md.matchAll(/\[[^\]]+\]\((\.\.?\/[^)#]+)/g)].map((m) => m[1]);

/** Reference-index rows: the linked file plus its `## heading` search hints. */
const indexRows = (md) =>
  md
    .split('\n')
    .map((line) => line.match(/^\| \[[^\]]+\]\(\.\/(references\/[^)]+)\)/))
    .filter(Boolean)
    .map((match) => ({
      file: match[1],
      hints: [...match.input.matchAll(/`(## [^`]+)`/g)].map((hint) => hint[1]),
    }));

describe('SKILL.md', () => {
  test('every relative link resolves to a file that exists', async () => {
    const md = await skillMd();
    const missing = links(md).filter((link) => !existsSync(join(SKILL_DIR, link)));

    assert.deepEqual(missing, []);
  });

  test('every reference is listed in the reference index', async () => {
    const md = await skillMd();
    const listed = new Set(indexRows(md).map((row) => row.file));

    const walk = async (dir, prefix) => {
      const found = [];

      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await walk(path, `${prefix}${entry.name}/`)));
        else if (entry.name.endsWith('.md')) found.push(`${prefix}${entry.name}`);
      }

      return found;
    };

    const onDisk = await walk(join(SKILL_DIR, 'references'), 'references/');

    assert.deepEqual(
      onDisk.filter((file) => !listed.has(file)),
      [],
      'reference file exists but is not in the index'
    );
  });

  test('every search hint matches a real heading in its reference', async () => {
    const md = await skillMd();
    const rows = indexRows(md);

    assert.ok(rows.length > 0, 'reference index rows were not parsed');

    for (const { file, hints } of rows) {
      const body = await readFile(join(SKILL_DIR, file), 'utf-8');

      assert.ok(hints.length > 0, `${file} has no search hints`);

      for (const hint of hints) {
        assert.ok(body.includes(hint), `${file} has no heading matching ${JSON.stringify(hint)}`);
      }
    }
  });

  test('the scaffold command in CREATE points at a script that exists', async () => {
    const md = await skillMd();
    const command = md.match(/scripts\/(scaffold_feature\.mjs)/);

    assert.ok(command, 'CREATE workflow no longer references the scaffold script');
    assert.ok(existsSync(join(SKILL_DIR, 'scripts', command[1])));
  });
});

describe('cross-skill consistency', () => {
  test('fe-architect and fe-patterns agree on the services split threshold', async () => {
    // Exactly 3 endpoints is the boundary case: it must resolve to the folder
    // variant in both skills. `> 3` phrasing would push it to the single file.
    const files = [
      join(SKILL_DIR, 'SKILL.md'),
      join(SKILL_DIR, 'references', 'implementation', 'templates.md'),
      join(SKILL_DIR, 'references', 'maintenance', 'migration.md'),
      join(PATTERNS_DIR, 'SKILL.md'),
      join(PATTERNS_DIR, 'references', 'decisions.md'),
      join(PATTERNS_DIR, 'references', 'enforcement.md'),
    ];

    const offenders = [];

    for (const file of files) {
      if (!existsSync(file)) continue;

      const body = await readFile(file, 'utf-8');

      for (const line of body.split('\n')) {
        if (!/endpoint/i.test(line)) continue;
        // `> 3 endpoints` and `more than 3 ... endpoints` both exclude 3 itself.
        if (/>\s*3\s*(\+)?\s*endpoint/i.test(line) && !/>=\s*3/.test(line)) {
          offenders.push(`${dirname(file).split('/').slice(-2).join('/')}: ${line.trim()}`);
        }
        if (/more than 3 (api )?endpoint/i.test(line)) {
          offenders.push(`${dirname(file).split('/').slice(-2).join('/')}: ${line.trim()}`);
        }
      }
    }

    assert.deepEqual(offenders, [], 'threshold excludes exactly 3 endpoints from the folder variant');
  });
});
