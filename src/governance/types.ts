/** The four autonomy levels for workflow governance. */
export type AutonomyLevel = "full" | "interactive" | "semi" | "supervised";

/** Actions that can be taken on a pending approval. */
export type ApprovalAction = "approve" | "reject" | "revision_requested";

/** Context stored when a revision is requested. */
export interface ApprovalContext {
  action: "revision_requested";
  feedback: string;
  requestedAt: string;
  requestedBy?: string;
}

/** Rule definition for auto-approving runs. */
export interface AutoApproveRule {
  label?: string;
  workflow_pattern?: string;
  max_cost?: number;
}

/** Context provided when evaluating auto-approve rules. */
export interface AutoApproveContext {
  labels: string[];
  workflowName: string;
  actualCost?: number;
}
