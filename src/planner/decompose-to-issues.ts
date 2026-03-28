import type { TrackerIssue } from "../tracker/types.js";

/**
 * Quick heuristic check whether a dispatch prompt is complex enough to decompose.
 * Returns true if the prompt should be decomposed into sub-issues.
 */
export function shouldDecompose(title: string, description: string): boolean {
  const text = `${title}\n${description}`;

  // Numbered lists or bullet points suggesting multiple tasks — check first
  const listPattern = /(?:^|\n)\s*(?:\d+\.|[-*•])\s+\S/gm;
  const listItems = (text.match(listPattern) ?? []).length;
  if (listItems >= 3) return true;

  // Multiple file references
  const multiFilePattern = /(?:src|test|lib)\/[\w/.=-]+\.(?:ts|js|tsx|jsx)/g;
  const fileRefs = (text.match(multiFilePattern) ?? []).length;
  if (fileRefs >= 4) return true;

  // Short prompts without structural signals → dispatch directly
  if (text.length < 200) return false;

  // Multi-feature conjunction signals in longer text
  const multiFeaturePattern = /\b(and also|plus |also add|additionally|as well as|in addition|multiple|several)\b/i;
  if (multiFeaturePattern.test(text)) return true;

  return false;
}

export interface DecomposeResult {
  parentIssue: TrackerIssue;
  childIssues: TrackerIssue[];
}

/**
 * Decompose a complex prompt into a parent issue and child sub-issues.
 * Uses simple text splitting heuristics — splits on numbered lists, bullet points,
 * or "and"/"also"/"plus" conjunctions to extract individual tasks.
 */
export function decomposeToIssues(
  title: string,
  description: string,
  options: {
    repo?: string;
    priority?: string | null;
    labels?: string[];
  } = {},
): DecomposeResult {
  const now = new Date().toISOString();
  const baseId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const parentIssue: TrackerIssue = {
    id: baseId,
    identifier: baseId,
    title,
    description: description ?? "",
    state: "open",
    priority: options.priority ?? null,
    labels: options.labels ?? [],
    assignees: [],
    url: "",
    created_at: now,
    updated_at: now,
    blocked_by: [],
    metadata: {
      source: "dispatch",
      decomposed: true,
      ...(options.repo ? { repo: options.repo } : {}),
    },
  };

  const subtasks = extractSubtasks(title, description);

  const childIssues: TrackerIssue[] = subtasks.map((subtask, idx) => {
    const childId = `${baseId}-sub-${idx + 1}`;
    return {
      id: childId,
      identifier: childId,
      title: subtask,
      description: `Sub-task of: ${title}\n\n${subtask}`,
      state: "open",
      priority: options.priority ?? null,
      labels: [...(options.labels ?? []), "sub-issue"],
      assignees: [],
      url: "",
      created_at: now,
      updated_at: now,
      blocked_by: [],
      metadata: {
        source: "dispatch",
        parentId: baseId,
        ...(options.repo ? { repo: options.repo } : {}),
      },
    };
  });

  return { parentIssue, childIssues };
}

/**
 * Extract individual sub-tasks from the combined title + description text.
 */
function extractSubtasks(title: string, description: string): string[] {
  const text = description || title;

  // Try numbered list: "1. foo\n2. bar\n3. baz"
  const numberedPattern = /(?:^|\n)\s*\d+\.\s+(.+)/g;
  const numbered: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = numberedPattern.exec(text)) !== null) {
    numbered.push(match[1].trim());
  }
  if (numbered.length >= 2) return numbered;

  // Try bullet list: "- foo\n- bar" or "* foo\n* bar"
  const bulletPattern = /(?:^|\n)\s*[-*•]\s+(.+)/g;
  const bullets: string[] = [];
  while ((match = bulletPattern.exec(text)) !== null) {
    bullets.push(match[1].trim());
  }
  if (bullets.length >= 2) return bullets;

  // Try splitting on conjunctions: "do X and also Y plus Z"
  const conjunctionPattern = /\b(?:and also|also add|additionally|plus |as well as|in addition)\b/i;
  const parts = text.split(conjunctionPattern).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts;

  // Fallback: split on sentence-level "and" when text is long
  if (text.length >= 200) {
    const sentences = text.split(/\.\s+/).filter((s) => s.trim().length > 10);
    if (sentences.length >= 2) return sentences.map((s) => s.trim());
  }

  // Cannot decompose meaningfully — return single task
  return [text];
}
