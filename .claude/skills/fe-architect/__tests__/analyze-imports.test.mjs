/**
 * Regression tests for scripts/analyze_imports.mjs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runScript, fixture, FIXTURES_DIR } from './helpers.mjs';

const analyze = (dir) => runScript('analyze_imports.mjs', [dir]);

/** Copies the imports fixture set so a test can drop extra files into it. */
async function withImportsFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'fe-architect-'));

  try {
    await cp(fixture('imports'), dir, { recursive: true });
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('analyze_imports', () => {
  describe('P0-2: type-only imports', () => {
    test('an inline `import { type X }` counts as type-only, not a violation', async () => {
      const { code, stdout } = await analyze(fixture('imports'));

      assert.ok(
        !stdout.includes('RUNTIME CROSS-FEATURE IMPORTS (VIOLATIONS)'),
        `inline type import reported as runtime:\n${stdout}`
      );
      assert.ok(stdout.includes('TYPE-ONLY CROSS-FEATURE IMPORTS (ALLOWED)'));
      assert.equal(code, 0);
    });

    test('a leading `import type` still counts as type-only', async () => {
      const result = await withImportsFixture(async (dir) => {
        await writeFile(
          join(dir, 'consumer', 'containers', 'leading-type-container.tsx'),
          "import type { ProviderData } from '#root/features/provider'\n\nexport const x: ProviderData | null = null\n"
        );

        return analyze(dir);
      });

      assert.equal(result.code, 0, result.stdout);
    });

    test('a mixed `import { A, type B }` is a runtime violation', async () => {
      const result = await withImportsFixture(async (dir) => {
        await writeFile(
          join(dir, 'consumer', 'containers', 'mixed-container.tsx'),
          "import { providerService, type ProviderData } from '#root/features/provider'\n\nexport const x = providerService\n"
        );

        return analyze(dir);
      });

      assert.ok(
        result.stdout.includes('RUNTIME CROSS-FEATURE IMPORTS (VIOLATIONS)'),
        `mixed import was allowed:\n${result.stdout}`
      );
      assert.equal(result.code, 1);
    });

    test('a plain value import remains a runtime violation', async () => {
      const result = await withImportsFixture(async (dir) => {
        await writeFile(
          join(dir, 'consumer', 'containers', 'value-container.tsx'),
          "import { providerService } from '#root/features/provider'\n\nexport const x = providerService\n"
        );

        return analyze(dir);
      });

      assert.equal(result.code, 1, result.stdout);
    });
  });

  test('fixture features are discovered from the parent directory', async () => {
    const { stdout } = await analyze(fixture('imports'));

    assert.ok(stdout.includes('consumer'));
    assert.ok(stdout.includes('provider'));
  });

  test('a missing features directory fails cleanly', async () => {
    const { code } = await analyze(join(FIXTURES_DIR, 'does-not-exist'));

    assert.equal(code, 1);
  });
});
