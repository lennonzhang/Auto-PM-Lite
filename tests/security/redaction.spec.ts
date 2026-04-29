import { describe, expect, it } from "vitest";
import { redactJson, redactText } from "../../src/core/redaction.js";

describe("redaction", () => {
  it("redacts built-in secret patterns", () => {
    const input = [
      "Bearer sk-ant-secret-value",
      "Authorization: Bearer sk-1234567890abcdef1234567890abcd",
      "x-api-key: sk-live-1234567890abcdef1234567890abcd",
      "AKIAABCDEFGHIJKLMNOP",
      "https://user:pass@example.com/path",
    ].join("\n");

    const output = redactText(input);

    expect(output).not.toContain("sk-ant-secret-value");
    expect(output).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(output).not.toContain("user:pass@");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts nested json values", () => {
    const output = redactJson({
      authorization: "Authorization: Bearer sk-1234567890abcdef1234567890abcd",
      note: "safe",
    });

    expect(JSON.stringify(output)).not.toContain("sk-1234567890abcdef1234567890abcd");
    expect(output.note).toBe("safe");
  });

  it("applies user-defined patterns", () => {
    const output = redactText("token=custom-secret", {
      additionalPatterns: ["custom-secret"],
    });

    expect(output).toBe("token=[REDACTED]");
  });
});
