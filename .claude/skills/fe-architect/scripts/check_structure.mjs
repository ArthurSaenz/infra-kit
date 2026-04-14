#!/usr/bin/env node
/**
 * Feature Structure Checker
 *
 * Validates feature folder structure compliance with architecture standards.
 * Checks for proper organization and naming of directories and files.
 *
 * Usage:
 *     node check_structure.mjs <feature-path>
 *     node check_structure.mjs features/user-profile
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename, extname } from 'path';
import { existsSync } from 'fs';

// ANSI color codes
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
  console.log(`${Colors.RED}✗ ${msg}${Colors.RESET}`);
}

function printWarning(msg) {
  console.log(`${Colors.YELLOW}⚠ ${msg}${Colors.RESET}`);
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

class StructureChecker {
  constructor(featurePath) {
    this.featurePath = featurePath;
    this.featureName = basename(featurePath);
    this.errors = [];
    this.warnings = [];
    this.successes = [];
    this.structure = {};
  }

  async check() {
    printHeader(`Checking Structure: ${this.featureName}`);

    if (!existsSync(this.featurePath)) {
      printError(`Feature path does not exist: ${this.featurePath}`);
      return false;
    }

    // 1. Map feature structure
    await this.mapStructure();

    // 2. Check required files
    this.checkRequiredFiles();

    // 3. Validate directory structure
    await this.validateDirectories();

    // 4. Check file naming conventions
    this.checkFileNaming();

    // 5. Validate services structure
    await this.validateServicesStructure();

    // 6. Check for unwanted files
    this.checkUnwantedFiles();

    // 7. Print structure tree
    await this.printStructureTree();

    // 8. Print summary
    this.printSummary();

    return this.errors.length === 0;
  }

  async mapStructure() {
    this.structure = {
      files: [],
      directories: [],
      components: [],
      containers: [],
      services: null, // 'file' or 'folder' or null
    };

    const entries = await readdir(this.featurePath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile()) {
        this.structure.files.push(entry.name);
      } else if (entry.isDirectory()) {
        this.structure.directories.push(entry.name);
      }
    }

    // Check for components
    const componentsDir = join(this.featurePath, 'components');
    if (existsSync(componentsDir)) {
      const componentEntries = await readdir(componentsDir, { withFileTypes: true });
      this.structure.components = componentEntries
        .filter(e => e.isFile() && e.name.endsWith('.tsx'))
        .map(e => e.name);
    }

    // Check for containers
    const containersDir = join(this.featurePath, 'containers');
    if (existsSync(containersDir)) {
      const containerEntries = await readdir(containersDir, { withFileTypes: true });
      this.structure.containers = containerEntries
        .filter(e => e.isFile() && e.name.endsWith('.tsx'))
        .map(e => e.name);
    }

    // Check services structure
    if (this.structure.files.includes('services.ts')) {
      this.structure.services = 'file';
    } else if (this.structure.directories.includes('services')) {
      this.structure.services = 'folder';
    }
  }

  checkRequiredFiles() {
    const requiredFiles = {
      'index.ts': 'Public API exports',
      'types.ts': 'TypeScript type definitions',
    };

    printInfo("Checking required files...");

    for (const [fileName, description] of Object.entries(requiredFiles)) {
      if (this.structure.files.includes(fileName)) {
        this.successes.push(`✓ ${fileName} - ${description}`);
      } else {
        this.errors.push(`Missing required file: ${fileName} (${description})`);
      }
    }

    console.log();
  }

  async validateDirectories() {
    printInfo("Validating directories...");

    const allowedDirs = new Set([
      'components', 'containers', 'services', 'docs',
      '__tests__', '__stories__', 'assets'
    ]);

    for (const dirName of this.structure.directories) {
      if (!allowedDirs.has(dirName) && !dirName.startsWith('.')) {
        this.warnings.push(
          `Unexpected directory: ${dirName} (allowed: ${Array.from(allowedDirs).join(', ')})`
        );
      }
    }

    // Check components structure
    if (this.structure.directories.includes('components')) {
      await this.validateComponentsDir();
    }

    // Check containers structure
    if (this.structure.directories.includes('containers')) {
      await this.validateContainersDir();
    }

    // Check feature-root __tests__/ and __stories__/ directories
    await this.validateTestAndStoryDirs();

    console.log();
  }

  async validateComponentsDir() {
    const componentsDir = join(this.featurePath, 'components');

    // Warn if old nested __tests__ or __stories__ dirs still exist
    const oldTestsDir = join(componentsDir, '__tests__');
    if (existsSync(oldTestsDir)) {
      this.warnings.push("components/__tests__/ found — tests should be in feature-root __tests__/ instead");
    }

    const oldStoriesDir = join(componentsDir, '__stories__');
    if (existsSync(oldStoriesDir)) {
      this.warnings.push("components/__stories__/ found — stories should be in feature-root __stories__/ instead");
    }

    // Validate component files
    for (const component of this.structure.components) {
      if (!component.endsWith('-component.tsx')) {
        this.errors.push(
          `Component file '${component}' should end with '-component.tsx'`
        );
      }
    }
  }

  async validateContainersDir() {
    const containersDir = join(this.featurePath, 'containers');

    // Warn if old nested __tests__ dir still exists
    const oldTestsDir = join(containersDir, '__tests__');
    if (existsSync(oldTestsDir)) {
      this.warnings.push("containers/__tests__/ found — tests should be in feature-root __tests__/ instead");
    }

    // Check for NO __stories__ (containers shouldn't have stories)
    const storiesDir = join(containersDir, '__stories__');
    if (existsSync(storiesDir)) {
      this.errors.push(
        "containers/ should NOT have __stories__/ (only dumb components have stories)"
      );
    }

    // Validate container files
    for (const container of this.structure.containers) {
      if (!container.endsWith('-container.tsx')) {
        this.errors.push(
          `Container file '${container}' should end with '-container.tsx'`
        );
      }
    }
  }

  async validateTestAndStoryDirs() {
    // Check for feature-root __tests__/ directory
    const testsDir = join(this.featurePath, '__tests__');
    if (!existsSync(testsDir)) {
      this.warnings.push("Feature should have __tests__/ directory at feature root");
    } else {
      this.successes.push("✓ __tests__/ exists at feature root");
    }

    // Check for feature-root __stories__/ directory (only if components exist)
    const componentsDir = join(this.featurePath, 'components');
    if (existsSync(componentsDir)) {
      const storiesDir = join(this.featurePath, '__stories__');
      if (!existsSync(storiesDir)) {
        this.warnings.push("Feature with components should have __stories__/ directory at feature root");
      } else {
        this.successes.push("✓ __stories__/ exists at feature root");
      }
    }
  }

  checkFileNaming() {
    printInfo("Checking file naming conventions...");

    for (const fileName of this.structure.files) {
      // Skip known good files
      if (['index.ts', 'types.ts', 'services.ts', 'analytics.ts'].includes(fileName)) {
        continue;
      }

      // Check for wrong casing (PascalCase files)
      if (fileName[0] === fileName[0].toUpperCase() && fileName[0] !== fileName[0].toLowerCase()) {
        this.errors.push(
          `File '${fileName}' should use kebab-case, not PascalCase`
        );
      }

      // Check for underscores (should use hyphens)
      if (fileName.includes('_') && !fileName.startsWith('__')) {
        this.warnings.push(
          `File '${fileName}' should use hyphens (-) not underscores (_)`
        );
      }
    }

    console.log();
  }

  async validateServicesStructure() {
    printInfo("Checking services structure...");

    if (this.structure.services === 'file') {
      const servicesFile = join(this.featurePath, 'services.ts');

      // Check file size
      try {
        const content = await readFile(servicesFile, 'utf-8');
        const lines = content.split('\n').length;

        if (lines > 250) {
          this.warnings.push(
            `services.ts has ${lines} lines (> 250). Consider refactoring to services/ folder`
          );
        } else {
          this.successes.push(`✓ services.ts size OK (${lines} lines)`);
        }
      } catch (e) {
        // Ignore errors
      }

    } else if (this.structure.services === 'folder') {
      const servicesDir = join(this.featurePath, 'services');

      // Check for required files in services folder
      const requiredServiceFiles = {
        'main.ts': 'Re-exports all atoms and functions',
      };

      const recommendedFiles = {
        'api.ts': 'API calls',
        'libs.ts': 'Pure business logic functions',
      };

      for (const [fileName, description] of Object.entries(requiredServiceFiles)) {
        const filePath = join(servicesDir, fileName);
        if (!existsSync(filePath)) {
          this.errors.push(
            `services/ folder missing required file: ${fileName} (${description})`
          );
        } else {
          this.successes.push(`✓ services/${fileName} exists`);
        }
      }

      for (const [fileName, description] of Object.entries(recommendedFiles)) {
        const filePath = join(servicesDir, fileName);
        if (!existsSync(filePath)) {
          this.warnings.push(
            `services/ folder should have ${fileName} (${description})`
          );
        }
      }

    } else if (this.structure.services === null) {
      this.warnings.push(
        "No services.ts or services/ folder found. Feature may not need state management (OK for pure UI features)"
      );
    }

    console.log();
  }

  checkUnwantedFiles() {
    printInfo("Checking for unwanted files...");

    const unwantedPatterns = [
      ['.js', 'Use TypeScript (.ts/.tsx) instead of JavaScript'],
      ['.jsx', 'Use TypeScript (.tsx) instead of JSX'],
      ['index.js', 'Use index.ts instead'],
      ['.DS_Store', 'macOS metadata file (should be in .gitignore)'],
      ['Thumbs.db', 'Windows metadata file (should be in .gitignore)'],
    ];

    for (const fileName of this.structure.files) {
      for (const [pattern, reason] of unwantedPatterns) {
        if (fileName.includes(pattern)) {
          this.warnings.push(`Unwanted file '${fileName}': ${reason}`);
        }
      }
    }

    console.log();
  }

  async printStructureTree() {
    printHeader("Feature Structure Tree");

    const printTree = async (path, prefix = "", isLast = true) => {
      // Get connector
      const connector = isLast ? "└── " : "├── ";

      const pathStat = await stat(path);

      // Print current item
      if (pathStat.isDirectory()) {
        console.log(`${prefix}${connector}${Colors.CYAN}${basename(path)}/${Colors.RESET}`);

        // Get children
        const entries = await readdir(path, { withFileTypes: true });
        const children = entries.sort((a, b) => {
          if (a.isDirectory() === b.isDirectory()) {
            return a.name.localeCompare(b.name);
          }
          return a.isDirectory() ? -1 : 1;
        });

        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          const isLastChild = i === children.length - 1;
          const extension = isLast ? "    " : "│   ";
          await printTree(join(path, child.name), prefix + extension, isLastChild);
        }
      } else {
        // Color files by type
        const fileName = basename(path);
        let color = Colors.RESET;

        if (fileName.endsWith('.tsx')) {
          color = Colors.GREEN;
        } else if (fileName.endsWith('.ts')) {
          color = Colors.BLUE;
        } else if (fileName.includes('.test.')) {
          color = Colors.YELLOW;
        } else if (fileName.includes('.stories.')) {
          color = Colors.MAGENTA;
        }

        console.log(`${prefix}${connector}${color}${fileName}${Colors.RESET}`);
      }
    };

    console.log(`${Colors.BOLD}${Colors.CYAN}${this.featureName}/${Colors.RESET}`);

    const entries = await readdir(this.featurePath, { withFileTypes: true });
    const children = entries.sort((a, b) => {
      if (a.isDirectory() === b.isDirectory()) {
        return a.name.localeCompare(b.name);
      }
      return a.isDirectory() ? -1 : 1;
    });

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      await printTree(join(this.featurePath, child.name), "", isLast);
    }

    console.log();
  }

  printSummary() {
    printHeader("Structure Check Summary");

    if (this.successes.length > 0) {
      console.log(`${Colors.GREEN}✓ Passed Checks (${this.successes.length}):${Colors.RESET}`);
      for (const success of this.successes) {
        console.log(`  ${Colors.GREEN}${success}${Colors.RESET}`);
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
      console.log(`${Colors.RED}${Colors.BOLD}❌ STRUCTURE CHECK FAILED${Colors.RESET}`);
      console.log(`   ${this.errors.length} error(s) must be fixed`);
    } else {
      console.log(`${Colors.GREEN}${Colors.BOLD}✅ STRUCTURE CHECK PASSED${Colors.RESET}`);
      if (this.warnings.length > 0) {
        console.log(`   ${this.warnings.length} warning(s) to review`);
      }
    }

    console.log();
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.log("Usage: node check_structure.mjs <feature-path>");
    console.log("Example: node check_structure.mjs features/user-profile");
    process.exit(1);
  }

  const featurePath = process.argv[2];
  const checker = new StructureChecker(featurePath);
  const success = await checker.check();

  process.exit(success ? 0 : 1);
}

main();
