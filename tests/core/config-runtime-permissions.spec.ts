import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (target) => {
    await fs.rm(target, { recursive: true, force: true });
  }));
});

describe("runtime-native profile permissions", () => {
  it("parses Claude and Codex native permission fields", async () => {
    const config = await loadConfig(await writeConfig(`
[profile.claude_auto]
runtime = "claude"
account = "anthropic_env"
policy = "edit"
model = "claude-opus-4-7"
claude_permission_mode = "auto"

[profile.codex_edit]
runtime = "codex"
account = "openai_env"
policy = "edit"
model = "gpt-5-codex"
codex_sandbox_mode = "workspace-write"
codex_approval_policy = "on-request"
codex_network_access_enabled = false
`));

    expect(config.profiles.claude_auto).toMatchObject({
      runtime: "claude",
      claudePermissionMode: "auto",
    });
    expect(config.profiles.codex_edit).toMatchObject({
      runtime: "codex",
      codexSandboxMode: "workspace-write",
      codexApprovalPolicy: "on-request",
      codexNetworkAccessEnabled: false,
    });
  });

  it("rejects profiles that omit runtime-native permission fields", async () => {
    await expect(loadConfig(await writeConfig(`
[profile.claude_missing]
runtime = "claude"
account = "anthropic_env"
policy = "edit"
model = "claude-opus-4-7"
`))).rejects.toThrow(/claudePermissionMode/);
  });

  it("rejects provider-specific permission fields on the wrong runtime", async () => {
    await expect(loadConfig(await writeConfig(`
[profile.claude_wrong]
runtime = "claude"
account = "anthropic_env"
policy = "edit"
model = "claude-opus-4-7"
claude_permission_mode = "default"
codex_sandbox_mode = "read-only"
`))).rejects.toThrow(/codexSandboxMode/);
  });
});

async function writeConfig(profileBody: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-pm-lite-config-perms-"));
  tempPaths.push(root);
  const configPath = path.join(root, "config.toml");
  await fs.writeFile(configPath, `
[storage]
db_path = "${path.join(root, "db.sqlite").replace(/\\/g, "/")}"
busy_timeout_ms = 1000

[workspace]
root_dir = "${path.join(root, "workspaces").replace(/\\/g, "/")}"
top_level_use_worktree = false

[policy.edit]
permission_mode = "edit"
sandbox_mode = "workspace-write"
network_allowed = false
approval_policy = "orchestrator"
require_approval_for = []
max_depth = 1
allow_cross_harness_delegation = false
allow_child_edit = false
allow_child_network = false

[account.anthropic_env]
vendor = "anthropic"
secret_ref = "env:ANTHROPIC_API_KEY"

[account.openai_env]
vendor = "openai"
secret_ref = "env:OPENAI_API_KEY"

${profileBody}
`, "utf8");
  return configPath;
}
