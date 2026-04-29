import type { Policy } from "../core/types.js";
import { canAccessReference, type ReferenceAccessContext } from "../core/reference.js";

export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;

export function mapClaudePermissionMode(policy: Policy): "dontAsk" | "default" {
  return policy.permissionMode === "read-only" ? "dontAsk" : "default";
}

export function allowedClaudeTools(policy: Policy): string[] | undefined {
  return policy.permissionMode === "read-only" ? [...CLAUDE_READ_ONLY_TOOLS] : undefined;
}

export function shouldRequireApproval(policy: Policy, kind: Policy["requireApprovalFor"][number]): boolean {
  return policy.requireApprovalFor.includes(kind);
}

export function canExpandReference(policy: Policy, context: ReferenceAccessContext): boolean {
  if (!policy.requireApprovalFor.includes("reference_access")) {
    return canAccessReference(context);
  }

  return canAccessReference(context) && context.explicitApproval;
}
