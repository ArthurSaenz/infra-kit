#!/usr/bin/env node
/**
 * Import Analyzer Script
 *
 * Analyzes imports across features to detect cross-feature dependencies.
 * Identifies runtime imports vs type-only imports.
 *
 * Usage:
 *     node analyze_imports.mjs <features-directory>
 *     node analyze_imports.mjs features/
 *
 * Options:
 *     --strict    Fail on any cross-feature imports (even type-only)
 *     --graph     Generate dependency graph
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
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
  console.log(`\n${Colors.BOLD}${Colors.MAGENTA}${'='.repeat(70)}${Colors.RESET}`);
  console.log(`${Colors.BOLD}${Colors.MAGENTA}${msg.padStart((70 + msg.length) / 2).padEnd(70)}${Colors.RESET}`);
  console.log(`${Colors.BOLD}${Colors.MAGENTA}${'='.repeat(70)}${Colors.RESET}\n`);
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

class ImportAnalyzer {
  constructor(featuresDir, strict = false) {
    this.featuresDir = featuresDir;
    this.strict = strict;
    this.features = [];
    this.runtimeImports = new Map(); // feature -> [(file, imported_feature, import_path)]
    this.typeImports = new Map();
    this.allImports = new Map(); // feature -> Set{imported_features}
  }

  async analyze() {
    printHeader("Cross-Feature Import Analysis");

    // 1. Discover features
    await this.discoverFeatures();

    // 2. Analyze imports in each feature
    await this.analyzeImports();

    // 3. Print results
    this.printResults();

    // 4. Print dependency graph
    this.printDependencyGraph();

    // 5. Return status
    return this.checkViolations();
  }

  async discoverFeatures() {
    if (!existsSync(this.featuresDir)) {
      printError(`Features directory not found: ${this.featuresDir}`);
      process.exit(1);
    }

    const entries = await readdir(this.featuresDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
        this.features.push(entry.name);
      }
    }

    printInfo(`Found ${this.features.length} features: ${this.features.join(', ')}`);
    console.log();
  }

  async analyzeImports() {
    for (const feature of this.features) {
      const featurePath = join(this.featuresDir, feature);
      await this.analyzeFeatureImports(feature, featurePath);
    }
  }

  async analyzeFeatureImports(feature, featurePath) {
    const tsPattern = /\.tsx?$/;

    for await (const tsFile of walkFiles(featurePath, tsPattern)) {
      // Skip test files
      if (tsFile.includes('__tests__') || tsFile.includes('.test.')) {
        continue;
      }

      try {
        const content = await readFile(tsFile, 'utf-8');
        this.extractImports(feature, tsFile, content);
      } catch (e) {
        printWarning(`Could not analyze ${tsFile}: ${e.message}`);
      }
    }
  }

  extractImports(feature, filePath, content) {
    // Pattern to match imports
    const importPattern = /import\s+(?<type>type\s+)?(?<imports>\{[^}]*\}|\*\s+as\s+\w+|[\w,\s]+)\s+from\s+['"](?<path>[^'"]+)['"]/g;

    let match;
    while ((match = importPattern.exec(content)) !== null) {
      const isTypeOnly = match.groups.type !== undefined;
      const importPath = match.groups.path;

      // Check if it's a feature import
      const importedFeature = this.extractFeatureFromImport(importPath);

      if (importedFeature && importedFeature !== feature) {
        const relFilePath = filePath.replace(this.featuresDir + '/', '');

        if (isTypeOnly) {
          if (!this.typeImports.has(feature)) {
            this.typeImports.set(feature, []);
          }
          this.typeImports.get(feature).push([relFilePath, importedFeature, importPath]);
        } else {
          if (!this.runtimeImports.has(feature)) {
            this.runtimeImports.set(feature, []);
          }
          this.runtimeImports.get(feature).push([relFilePath, importedFeature, importPath]);
        }

        if (!this.allImports.has(feature)) {
          this.allImports.set(feature, new Set());
        }
        this.allImports.get(feature).add(importedFeature);
      }
    }
  }

  extractFeatureFromImport(importPath) {
    // Patterns to match:
    // - #root/features/feature-name/...
    // - src/features/feature-name/...

    const patterns = [
      /features\/([a-z][a-z0-9-]+)/,
      /#root\/features\/([a-z][a-z0-9-]+)/,
      /@\/features\/([a-z][a-z0-9-]+)/,
    ];

    for (const pattern of patterns) {
      const match = importPath.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  printResults() {
    printHeader("Import Analysis Results");

    // Print runtime imports (VIOLATIONS)
    if (this.runtimeImports.size > 0) {
      console.log(`${Colors.RED}${Colors.BOLD}❌ RUNTIME CROSS-FEATURE IMPORTS (VIOLATIONS):${Colors.RESET}\n`);

      const sortedFeatures = Array.from(this.runtimeImports.keys()).sort();
      for (const feature of sortedFeatures) {
        const imports = this.runtimeImports.get(feature);
        console.log(`${Colors.RED}${Colors.BOLD}  Feature: ${feature}${Colors.RESET}`);
        for (const [filePath, importedFeature, importPath] of imports) {
          console.log(`    ${Colors.RED}✗${Colors.RESET} ${filePath}`);
          console.log(`      → imports from: ${Colors.RED}${importedFeature}${Colors.RESET}`);
          console.log(`      → path: ${importPath}`);
        }
        console.log();
      }
    } else {
      printSuccess("No runtime cross-feature imports found");
      console.log();
    }

    // Print type-only imports (ALLOWED but tracked)
    if (this.typeImports.size > 0) {
      console.log(`${Colors.CYAN}${Colors.BOLD}ℹ TYPE-ONLY CROSS-FEATURE IMPORTS (ALLOWED):${Colors.RESET}\n`);

      const sortedFeatures = Array.from(this.typeImports.keys()).sort();
      for (const feature of sortedFeatures) {
        const imports = this.typeImports.get(feature);
        console.log(`${Colors.CYAN}  Feature: ${feature}${Colors.RESET}`);
        for (const [filePath, importedFeature, importPath] of imports) {
          console.log(`    ${Colors.CYAN}ℹ${Colors.RESET} ${filePath}`);
          console.log(`      → type import from: ${Colors.CYAN}${importedFeature}${Colors.RESET}`);
        }
        console.log();
      }
    } else {
      printInfo("No type-only cross-feature imports found");
      console.log();
    }
  }

  printDependencyGraph() {
    printHeader("Feature Dependency Graph");

    if (this.allImports.size === 0) {
      printInfo("No cross-feature dependencies detected");
      return;
    }

    console.log("Dependency relationships (A → B means A imports from B):\n");

    for (const feature of this.features.sort()) {
      if (this.allImports.has(feature)) {
        const imports = Array.from(this.allImports.get(feature)).sort();
        const hasRuntime = this.runtimeImports.has(feature);

        const color = hasRuntime ? Colors.RED : Colors.CYAN;
        const arrow = hasRuntime ? "⚠→" : "→";

        console.log(`  ${color}${feature}${Colors.RESET} ${arrow} ${imports.join(', ')}`);
      } else {
        console.log(`  ${Colors.GREEN}${feature}${Colors.RESET} (no dependencies)`);
      }
    }

    console.log();

    // Print isolated features
    const isolated = this.features.filter(f => !this.allImports.has(f));
    if (isolated.length > 0) {
      console.log(`${Colors.GREEN}✓ Isolated features (good!):${Colors.RESET} ${isolated.join(', ')}`);
      console.log();
    }
  }

  checkViolations() {
    let hasViolations = false;

    if (this.runtimeImports.size > 0) {
      hasViolations = true;
      const count = Array.from(this.runtimeImports.values()).reduce((sum, arr) => sum + arr.length, 0);
      printError(
        `Found ${count} runtime cross-feature imports (VIOLATIONS)`
      );
    }

    if (this.strict && this.typeImports.size > 0) {
      hasViolations = true;
      const count = Array.from(this.typeImports.values()).reduce((sum, arr) => sum + arr.length, 0);
      printError(
        `Found ${count} type-only cross-feature imports (STRICT MODE)`
      );
    } else if (this.typeImports.size > 0) {
      const count = Array.from(this.typeImports.values()).reduce((sum, arr) => sum + arr.length, 0);
      printInfo(
        `Found ${count} type-only cross-feature imports (allowed)`
      );
    }

    if (!hasViolations) {
      printSuccess("✅ All features properly isolated!");
    }

    console.log();
    return !hasViolations;
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.log("Usage: node analyze_imports.mjs <features-directory> [--strict]");
    console.log("Example: node analyze_imports.mjs features/");
    process.exit(1);
  }

  const featuresDir = process.argv[2];
  const strict = process.argv.includes('--strict');

  const analyzer = new ImportAnalyzer(featuresDir, strict);
  const success = await analyzer.analyze();

  process.exit(success ? 0 : 1);
}

main();
