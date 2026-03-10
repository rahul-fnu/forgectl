import type { AutoApproveRule, AutoApproveContext } from "./types.js";

export function evaluateAutoApprove(_rules: AutoApproveRule | undefined, _context: AutoApproveContext): boolean {
  throw new Error("Not implemented");
}
