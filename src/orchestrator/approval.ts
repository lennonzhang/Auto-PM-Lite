import type { StoredApproval } from "../storage/db.js";

export function isApprovalExpired(approval: StoredApproval, now: string = new Date().toISOString()): boolean {
  if (!approval.expiresAt) {
    return false;
  }
  return approval.expiresAt < now;
}

export function expirePendingApprovals(approvals: StoredApproval[], now: string = new Date().toISOString()): string[] {
  return approvals
    .filter((approval) => approval.status === "pending" && isApprovalExpired(approval, now))
    .map((approval) => approval.id);
}
