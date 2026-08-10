/**
 * Regression tests for scripts/validate_feature.mjs.
 *
 * Every P0 case here was a false positive the validator produced against the
 * skill's own feature template. Test names carry the finding id so a future
 * regression points straight back at the plan entry.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runScript, errors, warnings, matches, fixture } from './helpers.mjs';

const validate = (feature) => runScript('validate_feature.mjs', [fixture(feature)]);

describe('validate_feature', () => {
  test('a correct feature passes with no errors and no warnings', async () => {
    const { code, stdout } = await validate('valid');

    assert.deepEqual(errors(stdout), [], 'expected no errors');
    assert.deepEqual(warnings(stdout), [], 'expected no warnings');
    assert.equal(code, 0);
  });

  describe('P0-1: atom classification', () => {
    test('a derived atom directly above a write-only Fx atom is not flagged', async () => {
      const { code, stdout } = await validate('derived-atom-above-fx');

      assert.ok(
        !matches(errors(stdout), '$hasData'),
        `derived atom was flagged: ${JSON.stringify(errors(stdout))}`
      );
      assert.ok(!matches(errors(stdout), "must have 'Fx' suffix"));
      assert.equal(code, 0);
    });

    test('a generic-typed atom is still checked for the $ prefix', async () => {
      // `atom<T>(...)` was invisible to the old `atom\(`-only regex.
      const { stdout } = await validate('both-services');

      assert.ok(
        matches(errors(stdout), 'badName', "must have '$' prefix"),
        `generic atom was not checked: ${JSON.stringify(errors(stdout))}`
      );
    });

    test('a write-only atom taking no arguments draws no object-args warning', async () => {
      const { stdout } = await validate('valid');

      assert.ok(!matches(warnings(stdout), 'resetValidAtom'));
    });
  });

  describe('P0-2: type-only imports', () => {
    test('an inline `import { type X }` is not a cross-feature violation', async () => {
      const { code, stdout } = await runScript('validate_feature.mjs', [
        fixture('imports', 'consumer'),
      ]);

      assert.ok(
        !matches(errors(stdout), 'Cross-feature import'),
        `inline type import was flagged: ${JSON.stringify(errors(stdout))}`
      );
      assert.equal(code, 0);
    });
  });

  describe('P0-3: className resolution', () => {
    test('className declared in types.ts satisfies rule 6', async () => {
      const { code, stdout } = await validate('props-in-types');

      assert.ok(
        !matches(errors(stdout), 'className'),
        `false className error: ${JSON.stringify(errors(stdout))}`
      );
      assert.ok(
        !matches(warnings(stdout), 'className'),
        `false className warning: ${JSON.stringify(warnings(stdout))}`
      );
      assert.equal(code, 0);
    });

    test('a genuinely missing className is a blocking error, not a warning', async () => {
      const { code, stdout } = await validate('missing-classname');

      assert.ok(
        matches(errors(stdout), 'className'),
        `expected a blocking className error, got: ${JSON.stringify(errors(stdout))}`
      );
      assert.ok(!matches(warnings(stdout), 'className'), 'must not double-report as a warning');
      assert.equal(code, 1);
    });
  });

  describe('P0-4: duplicate services variants', () => {
    test('findings are reported once, not once per services variant', async () => {
      const { stdout } = await validate('both-services');
      const badName = errors(stdout).filter((error) => error.includes('badName'));

      assert.equal(badName.length, 1, `duplicated findings: ${JSON.stringify(badName)}`);
    });

    test('shipping both services.ts and services/ is itself an error', async () => {
      const { code, stdout } = await validate('both-services');

      assert.ok(
        matches(errors(stdout), 'services.ts', 'services/'),
        `no conflict error: ${JSON.stringify(errors(stdout))}`
      );
      assert.equal(code, 1);
    });
  });

  describe('no duplication of lint-enforced rules', () => {
    test('story coverage is left to @wl/require-component-stories', async () => {
      // The rule enforces this at `error` with the same defaults (__stories__/,
      // .stories, -component). A second warning-level check here would only
      // restate, more weakly, a failure lint already blocks on.
      const dir = await mkdtemp(join(tmpdir(), 'fe-architect-'));

      try {
        const feature = join(dir, 'valid');
        await cp(fixture('valid'), feature, { recursive: true });
        await rm(join(feature, '__stories__'), { recursive: true });

        const { code, stdout } = await runScript('validate_feature.mjs', [feature]);

        assert.ok(
          !matches(warnings(stdout), 'story') && !matches(warnings(stdout), 'Storybook'),
          `story check came back: ${JSON.stringify(warnings(stdout))}`
        );
        assert.deepEqual(errors(stdout), []);
        assert.equal(code, 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('test coverage is still checked here — lint does not cover it', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'fe-architect-'));

      try {
        const feature = join(dir, 'valid');
        await cp(fixture('valid'), feature, { recursive: true });
        await rm(join(feature, '__tests__', 'valid-component.test.tsx'));

        const { stdout } = await runScript('validate_feature.mjs', [feature]);

        assert.ok(matches(warnings(stdout), 'Missing test for component'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('cross-feature imports are still checked here — lint has them at warn only', async () => {
      // `boundaries/dependencies` defaults to 'warn' (types.ts:12, options.ts:21)
      // and both consumer configs take the default, so dropping this check would
      // downgrade rule 1 from blocking to advisory.
      const dir = await mkdtemp(join(tmpdir(), 'fe-architect-'));

      try {
        const feature = join(dir, 'consumer');
        await cp(fixture('imports', 'consumer'), feature, { recursive: true });
        await writeFile(
          join(feature, 'containers', 'value-container.tsx'),
          "import { providerService } from '#root/features/provider'\n\nexport const x = providerService\n"
        );

        const { code, stdout } = await runScript('validate_feature.mjs', [feature]);

        assert.ok(matches(errors(stdout), 'Cross-feature import'));
        assert.equal(code, 1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('P0-6: path skipping', () => {
    test('a feature whose parent path contains __tests__ is still validated', async () => {
      // The skip check matched `__tests__` as a substring of the whole path, so
      // any feature nested under such a directory was skipped in full.
      const dir = await mkdtemp(join(tmpdir(), 'fe-architect-'));

      try {
        const feature = join(dir, '__tests__', 'nested', 'missing-classname');
        await mkdir(join(dir, '__tests__', 'nested'), { recursive: true });
        await cp(fixture('missing-classname'), feature, { recursive: true });

        const { code, stdout } = await runScript('validate_feature.mjs', [feature]);

        assert.ok(
          matches(errors(stdout), 'className'),
          `feature was skipped because of its path: ${JSON.stringify(errors(stdout))}`
        );
        assert.equal(code, 1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("a feature's own __tests__/ and __stories__/ are still skipped", async () => {
      // `valid/__tests__/` holds stub files that would otherwise be scanned.
      const { code, stdout } = await validate('valid');

      assert.deepEqual(errors(stdout), []);
      assert.equal(code, 0);
    });
  });

  test('a missing feature path fails cleanly', async () => {
    const { code } = await validate('does-not-exist');

    assert.equal(code, 1);
  });
});
