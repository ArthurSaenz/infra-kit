/**
 * End-to-end test for scripts/scaffold_feature.mjs.
 *
 * This is the acceptance test for the whole skill: a feature scaffolded from the
 * shipped template must pass the skill's own validators with a clean report.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runScript, errors, warnings } from './helpers.mjs';

/** Scaffolds into a throwaway features dir and hands the paths to `run`. */
const withScaffold = async (name, args, run) => {
  const featuresDir = await mkdtemp(join(tmpdir(), 'fe-architect-'));

  try {
    const scaffold = await runScript('scaffold_feature.mjs', [featuresDir, name, ...args]);
    return await run({ featuresDir, feature: join(featuresDir, name), scaffold });
  } finally {
    await rm(featuresDir, { recursive: true, force: true });
  }
};

describe('scaffold_feature', () => {
  test('a scaffolded feature passes validate_feature cleanly', async () => {
    await withScaffold('billing-summary', [], async ({ feature, scaffold }) => {
      assert.equal(scaffold.code, 0, scaffold.stdout + scaffold.stderr);

      const { code, stdout } = await runScript('validate_feature.mjs', [feature]);

      assert.deepEqual(errors(stdout), [], 'expected no errors');
      assert.deepEqual(warnings(stdout), [], 'expected no warnings');
      assert.equal(code, 0);
    });
  });

  test('a scaffolded feature passes check_structure cleanly', async () => {
    await withScaffold('billing-summary', [], async ({ feature }) => {
      const { code, stdout } = await runScript('check_structure.mjs', [feature]);

      assert.deepEqual(errors(stdout), [], 'expected no errors');
      assert.deepEqual(warnings(stdout), [], 'expected no warnings');
      assert.equal(code, 0);
    });
  });

  test('a scaffolded feature is isolated per analyze_imports', async () => {
    await withScaffold('billing-summary', [], async ({ featuresDir }) => {
      const { code } = await runScript('analyze_imports.mjs', [featuresDir]);

      assert.equal(code, 0);
    });
  });

  test('placeholders are substituted in file contents and file names', async () => {
    await withScaffold('billing-summary', [], async ({ feature }) => {
      const index = await readFile(join(feature, 'index.ts'), 'utf-8');

      assert.match(index, /billingSummaryService/);
      assert.match(index, /BillingSummaryContainer/);
      assert.ok(!index.includes('FeatureName'), 'PascalCase placeholder survived');
      assert.ok(!index.includes('featureName'), 'camelCase placeholder survived');

      assert.ok(existsSync(join(feature, 'components', 'billing-summary-component.tsx')));
      assert.ok(existsSync(join(feature, 'containers', 'billing-summary-container.tsx')));
      assert.ok(existsSync(join(feature, '__tests__', 'billing-summary-component.test.tsx')));
      assert.ok(existsSync(join(feature, '__stories__', 'billing-summary-component.stories.tsx')));
    });
  });

  test('no placeholder text survives anywhere in the tree', async () => {
    await withScaffold('billing-summary', [], async ({ feature }) => {
      const walk = async (dir) => {
        const found = [];

        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);

          if (entry.isDirectory()) {
            found.push(...(await walk(path)));
            continue;
          }

          const content = await readFile(path, 'utf-8');
          for (const placeholder of ['FeatureName', 'featureName', 'feature-name', 'Feature Name']) {
            if (content.includes(placeholder)) found.push(`${entry.name}: ${placeholder}`);
          }
        }

        return found;
      };

      assert.deepEqual(await walk(feature), []);
    });
  });

  test('the simple variant ships services.ts only', async () => {
    await withScaffold('billing-summary', [], async ({ feature }) => {
      assert.ok(existsSync(join(feature, 'services.ts')), 'services.ts missing');
      assert.ok(!existsSync(join(feature, 'services')), 'services/ should not be present');
    });
  });

  test('--complex ships the services/ folder only', async () => {
    await withScaffold('billing-summary', ['--complex'], async ({ feature }) => {
      assert.ok(existsSync(join(feature, 'services', 'main.ts')), 'services/main.ts missing');
      assert.ok(existsSync(join(feature, 'services', 'api.ts')));
      assert.ok(existsSync(join(feature, 'services', 'libs.ts')));
      assert.ok(!existsSync(join(feature, 'services.ts')), 'services.ts should not be present');
    });
  });

  test('--complex also passes both validators cleanly', async () => {
    await withScaffold('billing-summary', ['--complex'], async ({ feature }) => {
      const validate = await runScript('validate_feature.mjs', [feature]);
      assert.deepEqual(errors(validate.stdout), []);
      assert.deepEqual(warnings(validate.stdout), []);

      const structure = await runScript('check_structure.mjs', [feature]);
      assert.deepEqual(errors(structure.stdout), []);
      assert.deepEqual(warnings(structure.stdout), []);
    });
  });

  test('the template README is not copied into the feature', async () => {
    await withScaffold('billing-summary', [], async ({ feature }) => {
      assert.ok(!existsSync(join(feature, 'README.md')));
      assert.ok(!existsSync(join(feature, '_variants')));
    });
  });

  test('a non-kebab-case feature name is rejected', async () => {
    await withScaffold('BillingSummary', [], async ({ scaffold, feature }) => {
      assert.equal(scaffold.code, 1);
      assert.ok(!existsSync(feature), 'nothing should be written on rejection');
    });
  });

  test('scaffolding over an existing feature is refused', async () => {
    await withScaffold('billing-summary', [], async ({ featuresDir }) => {
      const again = await runScript('scaffold_feature.mjs', [featuresDir, 'billing-summary']);

      assert.equal(again.code, 1);
      assert.match(again.stdout + again.stderr, /exists/i);
    });
  });
});
