#!/usr/bin/env node
/**
 * Feature Validation Script
 *
 * Validates a feature folder for compliance with feature-based architecture rules:
 * - Naming conventions (atoms, components, services)
 * - File structure
 * - No cross-feature imports
 * - Required files (tests, stories)
 * - Public API exports
 *
 * Usage:
 *     node validate_feature.mjs <feature-path>
 *     node validate_feature.mjs features/user-profile
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename, extname, sep } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI color codes for terminal output
const Colors = {
  RED: '\x1b[91m',
  GREEN: '\x1b[92m',
  YELLOW: '\x1b[93m',
  BLUE: '\x1b[94m',
  MAGENTA: '\x1b[95m',
  CYAN: '\x1b[96m',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m'
};

function printError(msg) {
  console.log(`${Colors.RED}✗ ERROR: ${msg}${Colors.RESET}`);
}

function printWarning(msg) {
  console.log(`${Colors.YELLOW}⚠ WARNING: ${msg}${Colors.RESET}`);
}

function printSuccess(msg) {
  console.log(`${Colors.GREEN}✓ ${msg}${Colors.RESET}`);
}

function printInfo(msg) {
  console.log(`${Colors.CYAN}ℹ ${msg}${Colors.RESET}`);
}

function printHeader(msg) {
  console.log(`\n${Colors.BOLD}${Colors.MAGENTA}${'='.repeat(60)}${Colors.RESET}`);
  console.log(`${Colors.BOLD}${Colors.MAGENTA}${msg}${Colors.RESET}`);
  console.log(`${Colors.BOLD}${Colors.MAGENTA}${'='.repeat(60)}${Colors.RESET}\n`);
}

// Recursive file globbing helper
async function* walkFiles(dir, pattern) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, pattern);
    } else if (entry.isFile() && pattern.test(entry.name)) {
      yield fullPath;
    }
  }
}

class FeatureValidator {
  constructor(featurePath) {
    this.featurePath = featurePath;
    this.featureName = basename(featurePath);
    this.errors = [];
    this.warnings = [];
    this.successes = [];
  }

  async validate() {
    printHeader(`Validating Feature: ${this.featureName}`);

    // 1. Check feature exists
    if (!existsSync(this.featurePath)) {
      printError(`Feature path does not exist: ${this.featurePath}`);
      return false;
    }

    // 2. Validate feature name
    this.validateFeatureName();

    // 3. Check required files
    this.checkRequiredFiles();

    // 4. Validate naming conventions
    await this.validateNamingConventions();

    // 5. Check for cross-feature imports
    await this.checkCrossFeatureImports();

    // 6. Validate public API exports
    await this.validatePublicApi();

    // 7. Check test coverage
    await this.checkTestCoverage();

    // 8. Validate component structure
    await this.validateComponentStructure();

    // Print summary
    this.printSummary();

    return this.errors.length === 0;
  }

  validateFeatureName() {
    if (!/^[a-z][a-z0-9-]*$/.test(this.featureName)) {
      this.errors.push(
        `Feature name '${this.featureName}' must be kebab-case (lowercase with hyphens)`
      );
    } else {
      this.successes.push(`Feature name '${this.featureName}' is valid`);
    }
  }

  checkRequiredFiles() {
    const requiredFiles = ['index.ts', 'types.ts'];

    for (const file of requiredFiles) {
      const filePath = join(this.featurePath, file);
      if (!existsSync(filePath)) {
        this.errors.push(`Missing required file: ${file}`);
      } else {
        this.successes.push(`Required file exists: ${file}`);
      }
    }
  }

  async validateNamingConventions() {
    const tsPattern = /\.tsx?$/;

    for await (const tsFile of walkFiles(this.featurePath, tsPattern)) {
      if (tsFile.includes('__tests__') || tsFile.includes('__stories__')) {
        continue;
      }

      await this.validateFileNaming(tsFile);
    }
  }

  async validateFileNaming(filePath) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const fileName = basename(filePath);

      // Check for state atoms (must have $ prefix)
      const atomRegex = /export\s+const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*atom\(/g;
      let match;

      while ((match = atomRegex.exec(content)) !== null) {
        const atomName = match[1];

        // Get atom definition
        const atomDef = this.getAtomDefinition(content, match.index);
        const isWriteOnly = atomDef.includes('null,') || atomDef.startsWith('atom(null');

        if (isWriteOnly) {
          // Write-only atoms: async must have Fx, sync should have Atom
          if (atomDef.includes('async')) {
            if (!atomName.endsWith('Fx')) {
              this.errors.push(
                `Async write-only atom '${atomName}' in ${fileName} must have 'Fx' suffix`
              );
            }
          }
          // Check for object args (harder to validate statically)
          if (!this.hasObjectArgs(atomDef)) {
            this.warnings.push(
              `Write-only atom '${atomName}' in ${fileName} should use object arguments with typed interface`
            );
          }
        } else {
          // State or derived atoms must have $ prefix
          if (!atomName.startsWith('$')) {
            this.errors.push(
              `State/derived atom '${atomName}' in ${fileName} must have '$' prefix`
            );
          } else {
            this.successes.push(`Atom '${atomName}' has correct naming`);
          }
        }
      }

      // Check component naming
      if (filePath.includes('-component.tsx')) {
        this.validateComponentExport(filePath, content, 'Component');
      } else if (filePath.includes('-container.tsx')) {
        this.validateComponentExport(filePath, content, 'Container');
      }

    } catch (e) {
      this.warnings.push(`Could not validate ${basename(filePath)}: ${e.message}`);
    }
  }

  getAtomDefinition(content, startPos) {
    // Get the line containing the atom
    const snippet = content.slice(startPos, startPos + 500);
    const lines = snippet.split('\n').slice(0, 10);
    return lines.join(' ');
  }

  hasObjectArgs(atomDef) {
    // Look for patterns like: args: SomeInterface or args: { ... }
    return /args:\s*[A-Z]\w+/.test(atomDef) || /args:\s*\{/.test(atomDef);
  }

  validateComponentExport(filePath, content, suffix) {
    // Extract expected component name from file name
    const fileNameWithoutExt = basename(filePath, extname(filePath));
    const words = fileNameWithoutExt.split('-');
    const expectedName = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');

    // Look for export const ComponentName
    const exportRegex = new RegExp(`export\\s+const\\s+(${expectedName})\\s*=`);
    const exportMatch = content.match(exportRegex);

    if (!exportMatch) {
      this.errors.push(
        `Component in ${basename(filePath)} should export '${expectedName}'`
      );
    } else {
      this.successes.push(`Component '${expectedName}' correctly named`);
    }
  }

  async checkCrossFeatureImports() {
    const tsPattern = /\.tsx?$/;

    for await (const tsFile of walkFiles(this.featurePath, tsPattern)) {
      if (tsFile.includes('__tests__')) {
        continue;
      }

      try {
        const content = await readFile(tsFile, 'utf-8');

        // Look for imports from features/
        const importRegex = /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|[\w,\s]+)\s+from\s+['"]([^'"]+)['"]/g;
        let match;

        while ((match = importRegex.exec(content)) !== null) {
          const importPath = match[1];

          // Check if it's importing from features/ but not current feature
          if (importPath.includes('features/') || importPath.includes('/features/')) {
            // Check if it's NOT the current feature
            if (!importPath.includes(this.featureName)) {
              // Check if it's a type-only import (allowed)
              if (!match[0].includes('import type')) {
                this.errors.push(
                  `Cross-feature import in ${basename(tsFile)}: ${importPath} (Only type-only imports allowed)`
                );
              } else {
                this.successes.push(
                  `Type-only cross-feature import in ${basename(tsFile)} (OK)`
                );
              }
            }
          }
        }
      } catch (e) {
        this.warnings.push(`Could not check imports in ${basename(tsFile)}: ${e.message}`);
      }
    }
  }

  async validatePublicApi() {
    const indexPath = join(this.featurePath, 'index.ts');

    if (!existsSync(indexPath)) {
      return; // Already reported as error
    }

    try {
      const content = await readFile(indexPath, 'utf-8');

      // Check for service export
      const serviceExportRegex = /export\s+\*\s+as\s+(\w+Service)\s+from\s+['"]\.\/services['"]/;
      const serviceMatch = content.match(serviceExportRegex);

      if (serviceMatch) {
        const serviceName = serviceMatch[1];

        // Validate naming: should be {featureName}Service
        const words = this.featureName.split('-');
        const expectedServiceName = words.map((word, i) =>
          i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
        ).join('') + 'Service';

        if (serviceName !== expectedServiceName) {
          this.errors.push(
            `Service export name '${serviceName}' should be '${expectedServiceName}'`
          );
        } else {
          this.successes.push(`Service export '${serviceName}' correctly named`);
        }
      }

      // Check for container exports
      if (content.includes('export {') && content.includes('Container')) {
        this.successes.push("Container exports found in index.ts");
      }

    } catch (e) {
      this.warnings.push(`Could not validate index.ts: ${e.message}`);
    }
  }

  async checkTestCoverage() {
    const testsDir = join(this.featurePath, '__tests__');
    const storiesDir = join(this.featurePath, '__stories__');

    // Check dumb components
    const componentsDir = join(this.featurePath, 'components');

    if (existsSync(componentsDir)) {
      const entries = await readdir(componentsDir, { withFileTypes: true });
      const components = entries.filter(e => e.isFile() && e.name.endsWith('-component.tsx'));

      for (const component of components) {
        const testName = component.name.replace('.tsx', '.test.tsx');
        const testPath = join(testsDir, testName);

        if (!existsSync(testPath)) {
          this.warnings.push(`Missing test for component: ${component.name} (expected at __tests__/${testName})`);
        } else {
          this.successes.push(`Test exists for ${component.name}`);
        }

        // Check for stories
        const storyName = component.name.replace('.tsx', '.stories.tsx');
        const storyPath = join(storiesDir, storyName);

        if (!existsSync(storyPath)) {
          this.warnings.push(`Missing Storybook story for component: ${component.name} (expected at __stories__/${storyName})`);
        } else {
          this.successes.push(`Story exists for ${component.name}`);
        }
      }
    }

    // Check containers
    const containersDir = join(this.featurePath, 'containers');

    if (existsSync(containersDir)) {
      const entries = await readdir(containersDir, { withFileTypes: true });
      const containers = entries.filter(e => e.isFile() && e.name.endsWith('-container.tsx'));

      for (const container of containers) {
        const testName = container.name.replace('.tsx', '.test.tsx');
        const testPath = join(testsDir, testName);

        if (!existsSync(testPath)) {
          this.warnings.push(`Missing test for container: ${container.name} (expected at __tests__/${testName})`);
        } else {
          this.successes.push(`Test exists for ${container.name}`);
        }
      }
    }
  }

  async validateComponentStructure() {
    // Check dumb components don't import from services
    const componentsDir = join(this.featurePath, 'components');

    if (existsSync(componentsDir)) {
      const entries = await readdir(componentsDir, { withFileTypes: true });
      const components = entries.filter(e => e.isFile() && e.name.endsWith('-component.tsx'));

      for (const component of components) {
        try {
          const componentPath = join(componentsDir, component.name);
          const content = await readFile(componentPath, 'utf-8');

          // Check for forbidden imports in dumb components
          if (content.includes("from '../services'") || content.includes('from "../services"')) {
            this.errors.push(
              `Dumb component ${component.name} imports from services (forbidden)`
            );
          }

          if (content.includes('useAtomValue') || content.includes('useSetAtom') || content.includes('useAtom')) {
            this.errors.push(
              `Dumb component ${component.name} uses Jotai hooks (forbidden)`
            );
          }

          // Check for className prop
          if (content.includes('className?') || content.includes('className:')) {
            this.successes.push(`Component ${component.name} has className prop`);
          } else {
            this.warnings.push(
              `Component ${component.name} should accept className prop`
            );
          }

        } catch (e) {
          this.warnings.push(`Could not validate ${component.name}: ${e.message}`);
        }
      }
    }

    // Check containers handle loading/error/empty states
    const containersDir = join(this.featurePath, 'containers');

    if (existsSync(containersDir)) {
      const entries = await readdir(containersDir, { withFileTypes: true });
      const containers = entries.filter(e => e.isFile() && e.name.endsWith('-container.tsx'));

      for (const container of containers) {
        try {
          const containerPath = join(containersDir, container.name);
          const content = await readFile(containerPath, 'utf-8');

          // Check for state handling
          const hasLoading = content.includes('isLoading') || content.includes('loading');
          const hasError = content.includes('error');

          if (!hasLoading) {
            this.warnings.push(
              `Container ${container.name} should handle loading state`
            );
          }

          if (!hasError) {
            this.warnings.push(
              `Container ${container.name} should handle error state`
            );
          }

        } catch (e) {
          this.warnings.push(`Could not validate ${container.name}: ${e.message}`);
        }
      }
    }
  }

  printSummary() {
    printHeader("Validation Summary");

    if (this.successes.length > 0) {
      console.log(`${Colors.GREEN}✓ Successes (${this.successes.length}):${Colors.RESET}`);
      const displaySuccesses = this.successes.slice(0, 10);
      for (const success of displaySuccesses) {
        console.log(`  ${Colors.GREEN}✓${Colors.RESET} ${success}`);
      }
      if (this.successes.length > 10) {
        console.log(`  ... and ${this.successes.length - 10} more`);
      }
      console.log();
    }

    if (this.warnings.length > 0) {
      console.log(`${Colors.YELLOW}⚠ Warnings (${this.warnings.length}):${Colors.RESET}`);
      for (const warning of this.warnings) {
        console.log(`  ${Colors.YELLOW}⚠${Colors.RESET} ${warning}`);
      }
      console.log();
    }

    if (this.errors.length > 0) {
      console.log(`${Colors.RED}✗ Errors (${this.errors.length}):${Colors.RESET}`);
      for (const error of this.errors) {
        console.log(`  ${Colors.RED}✗${Colors.RESET} ${error}`);
      }
      console.log();
    }

    // Final verdict
    if (this.errors.length > 0) {
      console.log(`${Colors.RED}${Colors.BOLD}❌ VALIDATION FAILED${Colors.RESET}`);
      console.log(`   ${this.errors.length} error(s) must be fixed`);
    } else {
      console.log(`${Colors.GREEN}${Colors.BOLD}✅ VALIDATION PASSED${Colors.RESET}`);
      if (this.warnings.length > 0) {
        console.log(`   ${this.warnings.length} warning(s) to review`);
      }
    }

    console.log();
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.log("Usage: node validate_feature.mjs <feature-path>");
    console.log("Example: node validate_feature.mjs features/user-profile");
    process.exit(1);
  }

  const featurePath = process.argv[2];
  const validator = new FeatureValidator(featurePath);
  const success = await validator.validate();

  process.exit(success ? 0 : 1);
}

main();
