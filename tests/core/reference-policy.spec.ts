import { describe, expect, it } from "vitest";
import { canAccessReference, policyTrustLevel } from "../../src/core/reference.js";
import { categorizeApproval, type Policy } from "../../src/core/types.js";

describe("policyTrustLevel", () => {
  function policy(overrides: Partial<Policy>): Policy {
    return {
      id: "p",
      permissionMode: "read-only",
      sandboxMode: "read-only",
      networkAllowed: false,
      approvalPolicy: "orchestrator",
      requireApprovalFor: [],
      maxDepth: 1,
      allowCrossHarnessDelegation: false,
      allowChildEdit: false,
      allowChildNetwork: false,
      ...overrides,
    };
  }

  it("scores a strict read-only policy as 0", () => {
    expect(policyTrustLevel(policy({}))).toBe(0);
  });

  it("scores edit + workspace-write as 1", () => {
    expect(policyTrustLevel(policy({ permissionMode: "edit", sandboxMode: "workspace-write" }))).toBe(1);
  });

  it("scores full + danger sandbox + network as 3", () => {
    expect(
      policyTrustLevel(policy({ permissionMode: "full", sandboxMode: "danger-full-access", networkAllowed: true })),
    ).toBe(3);
  });
});

describe("canAccessReference", () => {
  it("allows self-access", () => {
    expect(
      canAccessReference({
        requesterTaskId: "t1",
        requesterLineage: ["t1"],
        targetTaskId: "t1",
        sameWorkspace: true,
        requesterTrustLevel: 0,
        targetTrustLevel: 0,
        explicitApproval: false,
      }),
    ).toBe(true);
  });

  it("denies low-trust child reading high-trust parent without approval", () => {
    expect(
      canAccessReference({
        requesterTaskId: "child",
        requesterLineage: ["child", "parent"],
        targetTaskId: "parent",
        sameWorkspace: false,
        requesterTrustLevel: 0,
        targetTrustLevel: 2,
        explicitApproval: false,
      }),
    ).toBe(false);
  });

  it("allows lineage access when trust is at least equal", () => {
    expect(
      canAccessReference({
        requesterTaskId: "child",
        requesterLineage: ["child", "parent"],
        targetTaskId: "parent",
        sameWorkspace: false,
        requesterTrustLevel: 2,
        targetTrustLevel: 1,
        explicitApproval: false,
      }),
    ).toBe(true);
  });

  it("explicit approval bypasses other gates", () => {
    expect(
      canAccessReference({
        requesterTaskId: "x",
        requesterLineage: ["x"],
        targetTaskId: "y",
        sameWorkspace: false,
        requesterTrustLevel: 0,
        targetTrustLevel: 99,
        explicitApproval: true,
      }),
    ).toBe(true);
  });
});

describe("categorizeApproval", () => {
  it("groups approvals into the four interaction classes", () => {
    expect(categorizeApproval("shell")).toBe("tool_approval");
    expect(categorizeApproval("file_edit")).toBe("tool_approval");
    expect(categorizeApproval("network")).toBe("tool_approval");
    expect(categorizeApproval("workspace_write")).toBe("privilege_escalation");
    expect(categorizeApproval("sandbox_escape")).toBe("privilege_escalation");
    expect(categorizeApproval("clarification")).toBe("clarification");
    expect(categorizeApproval("cross_harness_delegation")).toBe("capability_request");
    expect(categorizeApproval("budget_increase")).toBe("capability_request");
    expect(categorizeApproval("workspace_merge")).toBe("capability_request");
    expect(categorizeApproval("profile_switch")).toBe("capability_request");
  });
});
