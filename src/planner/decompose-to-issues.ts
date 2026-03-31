export interface DecomposedTask {
  title: string;
  description: string;
  dependsOn: number[];
}
export interface DecompositionResult {
  parent: { title: string; description: string };
  children: DecomposedTask[];
}
export async function decomposeToIssues(_prompt: string, _repo?: string): Promise<DecompositionResult> {
  return { parent: { title: _prompt.slice(0, 60), description: _prompt }, children: [] };
}

export function buildFeatureBranchName(slug: string): string {
  const ts = Date.now().toString(36);
  return `feature/${slug}-${ts}`;
}
