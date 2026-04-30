import type { Policy, TaskReference } from "./types.js";

export interface ReferenceAccessContext {
  requesterTaskId: string;
  requesterLineage: string[];
  targetTaskId: string;
  sameWorkspace: boolean;
  requesterTrustLevel: number;
  targetTrustLevel: number;
  explicitApproval: boolean;
}

/**
 * Trust score derived from a Policy. Higher = more privileged. The score is intentionally
 * coarse — we only need a partial order to answer "can a child read a parent's transcript".
 *
 *   read-only / read-only sandbox / no network    -> 0
 *   edit / workspace-write                        -> 1
 *   full / danger-full-access                     -> 2
 *   any of the above + network                    -> +1
 */
export function policyTrustLevel(policy: Policy): number {
  let score = 0;
  if (policy.permissionMode === "edit") {
    score = 1;
  } else if (policy.permissionMode === "full") {
    score = 2;
  }
  if (policy.sandboxMode === "workspace-write") {
    score = Math.max(score, 1);
  }
  if (policy.sandboxMode === "danger-full-access") {
    score = Math.max(score, 2);
  }
  if (policy.networkAllowed) {
    score += 1;
  }
  return score;
}

export function parseTaskReference(input: string): TaskReference | null {
  const match = input.match(/^@(?<taskId>[A-Za-z0-9_-]+):turn-(?<turnNumber>\d+)$/);
  if (!match?.groups) {
    return null;
  }

  const taskId = match.groups.taskId;
  const turnNumber = match.groups.turnNumber;
  if (!taskId || !turnNumber) {
    return null;
  }

  return {
    taskId,
    turnNumber: Number(turnNumber),
  };
}

export function canAccessReference(context: ReferenceAccessContext): boolean {
  if (context.explicitApproval) {
    return true;
  }

  if (context.requesterTaskId === context.targetTaskId) {
    return true;
  }

  if (context.requesterLineage.includes(context.targetTaskId) && context.requesterTrustLevel >= context.targetTrustLevel) {
    return true;
  }

  if (context.sameWorkspace && context.requesterTrustLevel >= context.targetTrustLevel) {
    return true;
  }

  return false;
}
