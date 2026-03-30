export interface ModuleExport {
  name: string;
  kind: string;
}

export interface ModuleImport {
  name: string;
  from: string;
}

export interface ModuleInfo {
  path: string;
  exports: ModuleExport[];
  imports: ModuleImport[];
  isTest: boolean;
}

export interface TestCoverageMapping {
  sourceFile: string;
  testFiles: string[];
  confidence: string;
}
