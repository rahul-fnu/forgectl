import { basename, dirname } from "node:path";
import type { ModuleInfo, TestCoverageMapping } from "./types.js";

/**
 * Build test coverage mappings from parsed module information.
 *
 * Uses three strategies:
 * 1. Import-based: If a test file imports a source file, they're mapped
 * 2. Name-based: src/foo/bar.ts maps to test/bar.test.ts
 * 3. Directory-based: src/foo/ maps to test/unit/foo/ or test/foo/
 */
export function buildTestMappings(modules: ModuleInfo[]): TestCoverageMapping[] {
  const sourceModules = modules.filter(m => !m.isTest);
  const testModules = modules.filter(m => m.isTest);

  const mappings = new Map<string, TestCoverageMapping>();

  // Strategy 1: Import-based (highest confidence)
  for (const testMod of testModules) {
    for (const imp of testMod.imports) {
      // Check if this import points to a source module
      const sourceMatch = sourceModules.find(s => s.path === imp.source);
      if (sourceMatch) {
        addMapping(mappings, sourceMatch.path, testMod.path, 'import');
      }
    }
  }

  // Strategy 2: Name-based
  for (const sourceMod of sourceModules) {
    const srcBase = basename(sourceMod.path).replace(/\.[tj]sx?$/, '');
    for (const testMod of testModules) {
      const testBase = basename(testMod.path)
        .replace(/\.test\.[tj]sx?$/, '')
        .replace(/\.spec\.[tj]sx?$/, '');
      if (srcBase === testBase && !hasMapping(mappings, sourceMod.path, testMod.path)) {
        addMapping(mappings, sourceMod.path, testMod.path, 'name_match');
      }
    }
  }

  // Strategy 3: Directory-based
  for (const sourceMod of sourceModules) {
    const srcDir = dirname(sourceMod.path);
    // Extract the subsystem directory (e.g., "config" from "src/config/loader.ts")
    const srcParts = srcDir.split('/');
    const srcIdx = srcParts.indexOf('src');
    if (srcIdx < 0) continue;
    const subPath = srcParts.slice(srcIdx + 1).join('/');
    if (!subPath) continue;

    for (const testMod of testModules) {
      const testDir = dirname(testMod.path);
      // Check if test is in test/unit/<subPath>/ or test/<subPath>/
      if (
        testDir.includes(`test/unit/${subPath}`) ||
        testDir.includes(`test/${subPath}`) ||
        testDir.includes(`__tests__/${subPath}`)
      ) {
        if (!hasMapping(mappings, sourceMod.path, testMod.path)) {
          addMapping(mappings, sourceMod.path, testMod.path, 'directory');
        }
      }
    }
  }

  return [...mappings.values()];
}

function addMapping(
  mappings: Map<string, TestCoverageMapping>,
  sourceFile: string,
  testFile: string,
  confidence: TestCoverageMapping['confidence'],
): void {
  const existing = mappings.get(sourceFile);
  if (existing) {
    if (!existing.testFiles.includes(testFile)) {
      existing.testFiles.push(testFile);
    }
    // Upgrade confidence if higher
    const order: Record<string, number> = { import: 3, name_match: 2, directory: 1 };
    if (order[confidence] > order[existing.confidence]) {
      existing.confidence = confidence;
    }
  } else {
    mappings.set(sourceFile, {
      sourceFile,
      testFiles: [testFile],
      confidence,
    });
  }
}

function hasMapping(
  mappings: Map<string, TestCoverageMapping>,
  sourceFile: string,
  testFile: string,
): boolean {
  const existing = mappings.get(sourceFile);
  return !!existing && existing.testFiles.includes(testFile);
}
