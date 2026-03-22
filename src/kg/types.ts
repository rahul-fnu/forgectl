export interface ModuleInfo {
  path: string;           // relative to repo root
  exports: ExportEntry[];
  imports: ImportEntry[];
  isTest: boolean;
  lastModified?: string;  // ISO timestamp
  contentHash?: string;   // SHA256 of semantic content
  treeHash?: string;      // SHA256 of sorted child tree hashes
  compressedContent?: string; // compact representation (signatures, imports, exports)
  tokenCount?: number;    // estimated token count of compressed content
}

export interface ExportEntry {
  name: string;
  kind: 'function' | 'class' | 'const' | 'type' | 'interface' | 'default' | 'unknown';
}

export interface ImportEntry {
  source: string;         // the import path (resolved to relative)
  names: string[];        // imported symbols
  isTypeOnly: boolean;
}

export interface DependencyEdge {
  from: string;           // source module path
  to: string;             // target module path
  imports: string[];      // imported symbols
  isTypeOnly: boolean;
}

export interface ChangeCoupling {
  fileA: string;
  fileB: string;
  cochangeCount: number;  // times they changed in same commit
  totalCommits: number;   // total commits touching either
  couplingScore: number;  // cochangeCount / min(commitsA, commitsB)
}

export interface TestCoverageMapping {
  sourceFile: string;
  testFiles: string[];
  confidence: 'import' | 'name_match' | 'directory';
}

export interface KnowledgeGraphStats {
  totalModules: number;
  totalEdges: number;
  totalTestMappings: number;
  totalCouplingPairs: number;
  lastFullBuild?: string;
  lastIncremental?: string;
  rootHash?: string;
  changedSinceLastBuild?: number;
}

export interface ModuleQueryResult {
  module: ModuleInfo;
  dependents: string[];          // who imports this
  dependencies: string[];        // what this imports
  transitiveDependents: string[]; // full impact
  testCoverage: TestCoverageMapping[];
  changeCoupling: ChangeCoupling[];
}
