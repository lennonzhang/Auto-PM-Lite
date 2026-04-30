import { describe, expect, it } from "vitest";
import { sanitizeEnvKey } from "../../src/core/credentials.js";
import { canAccessReference, parseTaskReference } from "../../src/core/reference.js";
import { allowedClaudeTools, canExpandReference, mapClaudePermissionMode } from "../../src/orchestrator/policy.js";
import type { Policy } from "../../src/core/types.js";

const basePolicy: Policy = {
  id: "p1",
  permissionMode: "read-only",
  sandboxMode: "read-only",
  networkAllowed: false,
  approvalPolicy: "orchestrator",
  requireApprovalFor: [],
  maxDepth: 1,
  allowCrossHarnessDelegation: false,
  allowChildEdit: false,
  allowChildNetwork: false,
};

describe("policy", () => {
  it("maps read-only Claude mode to dontAsk with static tool allowlist", () => {
    expect(mapClaudePermissionMode(basePolicy)).toBe("dontAsk");
    expect(allowedClaudeTools(basePolicy)).toEqual(["Read", "Glob", "Grep"]);
  });

  it("maps editable Claude mode to default without static allowlist", () => {
    const policy: Policy = { ...basePolicy, permissionMode: "edit" };
    expect(mapClaudePermissionMode(policy)).toBe("default");
    expect(allowedClaudeTools(policy)).toBeUndefined();
  });

  it("sanitizes env keys for provider injection", () => {
    expect(sanitizeEnvKey("openai-main")).toBe("AUTO_PM_KEY_OPENAI_MAIN");
    expect(sanitizeEnvKey(" azure/prod ")).toBe("AUTO_PM_KEY_AZURE_PROD");
  });

  it("parses task references", () => {
    expect(parseTaskReference("@task_1:turn-3")).toEqual({ taskId: "task_1", turnNumber: 3 });
    expect(parseTaskReference("task_1:turn-3")).toBeNull();
  });

  it("allows same-lineage reference access with sufficient trust", () => {
    expect(canAccessReference({
      requesterTaskId: "child",
      requesterLineage: ["parent"],
      targetTaskId: "parent",
      sameWorkspace: false,
      requesterTrustLevel: 2,
      targetTrustLevel: 1,
      explicitApproval: false,
    })).toBe(true);
  });

  it("denies higher-trust references without approval", () => {
    expect(canExpandReference(
      { ...basePolicy, requireApprovalFor: ["profile_switch"] },
      {
        requesterTaskId: "child",
        requesterLineage: ["parent"],
        targetTaskId: "parent",
        sameWorkspace: true,
        requesterTrustLevel: 1,
        targetTrustLevel: 2,
        explicitApproval: false,
      },
    )).toBe(false);
  });
});
