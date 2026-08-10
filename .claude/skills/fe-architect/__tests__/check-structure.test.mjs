/**
 * Regression tests for scripts/check_structure.mjs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runScript, errors, warnings, matches, fixture } from './helpers.mjs';

const check = (feature) => runScript('check_structure.mjs', [fixture(feature)]);

describe('check_structure', () => {
  test('a correct feature passes with no errors and no warnings', async () => {
    const { code, stdout } = await check('valid');

    assert.deepEqual(errors(stdout), [], 'expected no errors');
    assert.deepEqual(warnings(stdout), [], 'expected no warnings');
    assert.equal(code, 0);
  });

  describe('P0-4: duplicate services variants', () => {
    test('both services.ts and services/ present is an error', async () => {
      const { code, stdout } = await check('both-services');

      assert.ok(
        matches(errors(stdout), 'services.ts', 'services/'),
        `no conflict error: ${JSON.stringify(errors(stdout))}`
      );
      assert.equal(code, 1);
    });

    test('the services/ folder is still validated when services.ts shadows it', async () => {
      // The old `if/else if` set services='file' and skipped the folder checks
      // entirely, so a missing services/main.ts went unnoticed.
      const { stdout } = await check('both-services');

      assert.ok(
        matches(errors(stdout), 'api.ts') || matches(warnings(stdout), 'api.ts'),
        `folder contents were not inspected: ${JSON.stringify([
          ...errors(stdout),
          ...warnings(stdout),
        ])}`
      );
    });
  });

  describe('P0-5: markdown files', () => {
    test('a README.md inside a feature is not a kebab-case error', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'fe-architect-'));

      try {
        const feature = join(dir, 'valid');
        await cp(fixture('valid'), feature, { recursive: true });
        await writeFile(join(feature, 'README.md'), '# notes\n');

        const { code, stdout } = await runScript('check_structure.mjs', [feature]);

        assert.ok(
          !matches(errors(stdout), 'README.md'),
          `markdown flagged as PascalCase: ${JSON.stringify(errors(stdout))}`
        );
        assert.equal(code, 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test('a missing feature path fails cleanly', async () => {
    const { code } = await check('does-not-exist');

    assert.equal(code, 1);
  });
});
