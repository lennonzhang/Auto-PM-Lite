import type { TaskReference } from "./types.js";

export interface ReferenceAccessContext {
  requesterTaskId: string;
  requesterLineage: string[];
  targetTaskId: string;
  sameWorkspace: boolean;
  requesterTrustLevel: number;
  targetTrustLevel: number;
  explicitApproval: boolean;
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
