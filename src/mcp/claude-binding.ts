import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { AutoPmMcpService } from "./auto-pm-service.js";

export function createClaudeMcpServer(service: AutoPmMcpService) {
  return createSdkMcpServer({
    name: "auto-pm-lite",
    version: "0.1.0",
    tools: service.toClaudeTools(),
  });
}
