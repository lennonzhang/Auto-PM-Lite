import type { ApprovalKind, Policy } from "../core/types.js";
import { canAccessReference, type ReferenceAccessContext } from "../core/reference.js";

export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;
export const CLAUDE_EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"] as const;

// Permission model:
//   read-only -> dontAsk + static allowedTools (Read/Glob/Grep). No canUseTool needed; the
//                SDK simply refuses anything else.
//   edit/full -> default + canUseTool. Approvals route through orchestrator.requestCapability
//                so the parent agent is never the approval authority.
//   acceptEdits is intentionally NOT used: it broadens file operations and weakens the boundary
//   we want canUseTool to enforce. If a profile genuinely needs autopilot, expose that explicitly
//   as `unsafeAcceptEdits` later — never as the default.
export function mapClaudePermissionMode(policy: Policy): "dontAsk" | "default" {
  return policy.permissionMode === "read-only" ? "dontAsk" : "default";
}

export function allowedClaudeTools(policy: Policy): string[] | undefined {
  return policy.permissionMode === "read-only" ? [...CLAUDE_READ_ONLY_TOOLS] : undefined;
}

export function isClaudeEditTool(toolName: string): boolean {
  return (CLAUDE_EDIT_TOOLS as readonly string[]).includes(toolName);
}

export function shouldRequireApproval(policy: Policy, kind: ApprovalKind): boolean {
  return policy.requireApprovalFor.includes(kind);
}

export function canExpandReference(policy: Policy, context: ReferenceAccessContext): boolean {
  return canAccessReference(context);
}

export function classifyClaudeTool(toolName: string): ApprovalKind | null {
  switch (toolName) {
    case "Bash":
      return "shell";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "file_edit";
    case "WebFetch":
    case "WebSearch":
      return "network";
    default:
      return null;
  }
}

export function classifyCapabilityReason(kind: "filesystem" | "network" | "delegation" | "workspace_merge" | "reference_access"): ApprovalKind {
  switch (kind) {
    case "filesystem":
      return "workspace_write";
    case "delegation":
      return "cross_harness_delegation";
    case "network":
      return "network";
    case "workspace_merge":
      return "workspace_merge";
    case "reference_access":
      return "profile_switch";
  }
}
