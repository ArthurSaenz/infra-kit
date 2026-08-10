/**
 * Shared helpers for the fe-architect validator tests.
 *
 * Not named `*.test.mjs`, so `pnpm run test:claude` does not pick this up as a
 * suite of its own.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SKILL_DIR = join(__dirname, '..');
export const SCRIPTS_DIR = join(SKILL_DIR, 'scripts');
// Fixtures deliberately live outside `__tests__/`: the validators skip files
// whose path contains `__tests__`, so fixtures kept in here would be silently
// skipped and the suite would pass vacuously.
export const FIXTURES_DIR = join(SKILL_DIR, '__fixtures__');

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Runs one of the skill's scripts and captures its exit code and output.
 *
 * @param {string} script  file name inside scripts/, e.g. 'validate_feature.mjs'
 * @param {string[]} args  argv passed to the script
 * @returns {Promise<{code: number, stdout: string}>}
 */
export function runScript(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout: stdout.replace(ANSI, ''), stderr: stderr.replace(ANSI, '') });
    });
  });
}

/**
 * Pulls the items of one summary section out of a script's stripped stdout.
 *
 * Section headers are printed at column 0 (`✗ Errors (3):`) and their items are
 * indented and marker-prefixed (`  ✗ message`), which is what separates them
 * from the structure tree and the info lines.
 *
 * @param {string} stdout  ANSI-stripped script output
 * @param {'errors'|'warnings'} section
 * @returns {string[]}
 */
export function section(stdout, section) {
  const marker = section === 'errors' ? '✗' : '⚠';
  const header = section === 'errors' ? 'Errors' : 'Warnings';
  const lines = stdout.split('\n');
  const items = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith(`${marker} ${header} (`)) {
      inSection = true;
      continue;
    }

    if (!inSection) continue;

    const item = line.match(new RegExp(`^\\s{2}${marker}\\s+(.*)$`));
    if (item) {
      items.push(item[1].trim());
    } else if (line.trim() === '') {
      break;
    }
  }

  return items;
}

export const errors = (stdout) => section(stdout, 'errors');
export const warnings = (stdout) => section(stdout, 'warnings');

/** True when any item in `items` contains every fragment in `fragments`. */
export const matches = (items, ...fragments) =>
  items.some((item) => fragments.every((fragment) => item.includes(fragment)));

export const fixture = (...segments) => join(FIXTURES_DIR, ...segments);
