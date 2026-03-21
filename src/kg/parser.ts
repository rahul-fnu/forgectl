import { join, dirname, relative, resolve, extname, basename } from "node:path";
import { existsSync } from "node:fs";
import type { ModuleInfo, ExportEntry, ImportEntry } from "./types.js";

/**
 * Regex patterns for TypeScript import/export parsing.
 */

// import { X, Y } from './path'
// import { X as Z } from './path'
// import type { X } from './path'
const NAMED_IMPORT_RE = /import\s+(type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

// import X from './path'
// import type X from './path'
const DEFAULT_IMPORT_RE = /import\s+(type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/g;

// import * as X from './path'
const NAMESPACE_IMPORT_RE = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;

// import './path' (side-effect only)
const SIDE_EFFECT_IMPORT_RE = /import\s+['"]([^'"]+)['"]/g;

// Dynamic import: import('./path')
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

// export { X, Y } from './path' (re-exports)
const REEXPORT_RE = /export\s+(type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

// export * from './path'
const STAR_REEXPORT_RE = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;

// export function X(
const EXPORT_FUNCTION_RE = /export\s+(?:async\s+)?function\s+(\w+)/g;

// export class X
const EXPORT_CLASS_RE = /export\s+class\s+(\w+)/g;

// export const X / export let X / export var X
const EXPORT_CONST_RE = /export\s+(?:const|let|var)\s+(\w+)/g;

// export type X
const EXPORT_TYPE_RE = /export\s+type\s+(\w+)/g;

// export interface X
const EXPORT_INTERFACE_RE = /export\s+interface\s+(\w+)/g;

// export default
const EXPORT_DEFAULT_RE = /export\s+default\s+/g;

// export enum X
const EXPORT_ENUM_RE = /export\s+enum\s+(\w+)/g;

/** Test file path patterns */
const TEST_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /(^|[\\/])test[\\/]/,
  /(^|[\\/])tests[\\/]/,
  /(^|[\\/])__tests__[\\/]/,
];

/**
 * Strip single-line and multi-line comments from source code.
 * This prevents false matches inside comments.
 */
function stripComments(content: string): string {
  // Remove single-line comments (but not URLs with //)
  let result = content.replace(/(?<![:'"])\/\/.*$/gm, '');
  // Remove multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  return result;
}

/**
 * Parse a TypeScript module file and extract imports/exports.
 */
export function parseModule(filePath: string, content: string, repoRoot: string): ModuleInfo {
  const relPath = relative(repoRoot, filePath).replace(/\\/g, '/');
  const fileDir = dirname(filePath);
  const stripped = stripComments(content);

  const imports = parseImports(stripped, fileDir, repoRoot);
  const exports = parseExports(stripped);
  const isTest = isTestFile(relPath);

  return {
    path: relPath,
    exports,
    imports,
    isTest,
  };
}

/**
 * Determine if a file path represents a test file.
 */
export function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some(p => p.test(filePath));
}

/**
 * Resolve a relative import path to a file path relative to the repo root.
 * Handles:
 * - Relative paths (./foo, ../bar)
 * - .js extension mapping to .ts
 * - Directory imports resolving to index.ts
 */
export function resolveImportPath(importPath: string, fromDir: string, repoRoot: string): string | null {
  // Skip non-relative imports (node_modules packages)
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    return null;
  }

  const absolutePath = resolve(fromDir, importPath);
  let resolved: string | null = null;

  // Try direct match
  if (existsSync(absolutePath) && !isDirectory(absolutePath)) {
    resolved = absolutePath;
  }
  // Try .ts extension
  else if (existsSync(absolutePath + '.ts')) {
    resolved = absolutePath + '.ts';
  }
  // Try .tsx extension
  else if (existsSync(absolutePath + '.tsx')) {
    resolved = absolutePath + '.tsx';
  }
  // Try .js → .ts mapping
  else if (extname(importPath) === '.js') {
    const tsPath = absolutePath.replace(/\.js$/, '.ts');
    if (existsSync(tsPath)) {
      resolved = tsPath;
    }
    const tsxPath = absolutePath.replace(/\.js$/, '.tsx');
    if (!resolved && existsSync(tsxPath)) {
      resolved = tsxPath;
    }
  }
  // Try directory/index.ts
  else if (isDirectory(absolutePath)) {
    const indexTs = join(absolutePath, 'index.ts');
    if (existsSync(indexTs)) {
      resolved = indexTs;
    }
    const indexTsx = join(absolutePath, 'index.tsx');
    if (!resolved && existsSync(indexTsx)) {
      resolved = indexTsx;
    }
  }

  if (!resolved) {
    // Return best-guess path for non-existent files
    return null;
  }

  return relative(repoRoot, resolved).replace(/\\/g, '/');
}

function isDirectory(p: string): boolean {
  try {
    const { statSync } = require('node:fs');
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function parseImports(content: string, fileDir: string, repoRoot: string): ImportEntry[] {
  const imports: ImportEntry[] = [];
  const seen = new Map<string, ImportEntry>();

  function addImport(source: string, names: string[], isTypeOnly: boolean) {
    const resolved = resolveImportPath(source, fileDir, repoRoot);
    const key = resolved || source;
    const existing = seen.get(key);
    if (existing) {
      for (const n of names) {
        if (!existing.names.includes(n)) {
          existing.names.push(n);
        }
      }
      // If any import is value (not type-only), mark as not type-only
      if (!isTypeOnly) {
        existing.isTypeOnly = false;
      }
    } else {
      const entry: ImportEntry = {
        source: resolved || source,
        names: [...names],
        isTypeOnly,
      };
      seen.set(key, entry);
      imports.push(entry);
    }
  }

  // Named imports
  let match: RegExpExecArray | null;
  const namedRe = new RegExp(NAMED_IMPORT_RE.source, 'g');
  while ((match = namedRe.exec(content)) !== null) {
    const isType = !!match[1];
    const names = match[2].split(',').map(n => {
      const parts = n.trim().split(/\s+as\s+/);
      return parts[0].trim();
    }).filter(n => n.length > 0);
    addImport(match[3], names, isType);
  }

  // Default imports
  const defaultRe = new RegExp(DEFAULT_IMPORT_RE.source, 'g');
  while ((match = defaultRe.exec(content)) !== null) {
    // Skip if this is actually a named import (already matched)
    const isType = !!match[1];
    addImport(match[3], [match[2]], isType);
  }

  // Namespace imports
  const nsRe = new RegExp(NAMESPACE_IMPORT_RE.source, 'g');
  while ((match = nsRe.exec(content)) !== null) {
    addImport(match[2], ['*'], false);
  }

  // Side-effect imports
  const sideRe = new RegExp(SIDE_EFFECT_IMPORT_RE.source, 'g');
  while ((match = sideRe.exec(content)) !== null) {
    // Filter out lines that are part of named/default/namespace imports
    const line = content.substring(
      content.lastIndexOf('\n', match.index) + 1,
      content.indexOf('\n', match.index + match[0].length)
    );
    if (line.includes('{') || line.includes('from') || line.includes('* as')) continue;
    addImport(match[1], [], false);
  }

  // Dynamic imports
  const dynRe = new RegExp(DYNAMIC_IMPORT_RE.source, 'g');
  while ((match = dynRe.exec(content)) !== null) {
    addImport(match[1], ['*'], false);
  }

  // Re-exports (count as both import and tracked separately)
  const reexRe = new RegExp(REEXPORT_RE.source, 'g');
  while ((match = reexRe.exec(content)) !== null) {
    const isType = !!match[1];
    const names = match[2].split(',').map(n => {
      const parts = n.trim().split(/\s+as\s+/);
      return parts[0].trim();
    }).filter(n => n.length > 0);
    addImport(match[3], names, isType);
  }

  // Star re-exports
  const starRe = new RegExp(STAR_REEXPORT_RE.source, 'g');
  while ((match = starRe.exec(content)) !== null) {
    addImport(match[1], ['*'], false);
  }

  return imports;
}

function parseExports(content: string): ExportEntry[] {
  const exports: ExportEntry[] = [];
  const seen = new Set<string>();

  function add(name: string, kind: ExportEntry['kind']) {
    const key = `${name}:${kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      exports.push({ name, kind });
    }
  }

  let match: RegExpExecArray | null;

  // Functions
  const fnRe = new RegExp(EXPORT_FUNCTION_RE.source, 'g');
  while ((match = fnRe.exec(content)) !== null) {
    add(match[1], 'function');
  }

  // Classes
  const classRe = new RegExp(EXPORT_CLASS_RE.source, 'g');
  while ((match = classRe.exec(content)) !== null) {
    add(match[1], 'class');
  }

  // Constants
  const constRe = new RegExp(EXPORT_CONST_RE.source, 'g');
  while ((match = constRe.exec(content)) !== null) {
    add(match[1], 'const');
  }

  // Types
  const typeRe = new RegExp(EXPORT_TYPE_RE.source, 'g');
  while ((match = typeRe.exec(content)) !== null) {
    add(match[1], 'type');
  }

  // Interfaces
  const ifaceRe = new RegExp(EXPORT_INTERFACE_RE.source, 'g');
  while ((match = ifaceRe.exec(content)) !== null) {
    add(match[1], 'interface');
  }

  // Enums (treated as 'const' kind)
  const enumRe = new RegExp(EXPORT_ENUM_RE.source, 'g');
  while ((match = enumRe.exec(content)) !== null) {
    add(match[1], 'const');
  }

  // Default export
  const defaultRe = new RegExp(EXPORT_DEFAULT_RE.source, 'g');
  if (defaultRe.exec(content) !== null) {
    add('default', 'default');
  }

  return exports;
}
