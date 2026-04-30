# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```sh
pnpm build       # Compile with tsup (outputs to dist/)
pnpm dev         # Run src/index.ts with tsx (no compilation)
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm test:watch  # vitest (watch mode)
```

Run a single test file:

```sh
pnpm vitest run tests/orchestrator/policy.spec.ts
```

Run spike experiments (章0 verification of SDK behaviors):

```sh
pnpm spike:claude:permissions  # Claude Agent SDK permission/canUseTool
pnpm spike:claude:mcp          # Claude in-process MCP delegation
pnpm spike:codex:stream        # Codex SDK stream events
pnpm spike:codex:mcp           # Codex MCP server integration
pnpm spike:codex:approval      # Codex approval events
pnpm test:live                 # Live smoke test
```

Node 22+ required (`"engines": ">=22.0.0"`). Uses ESM only.

## Architecture

Auto-PM-Lite is a **control plane** for coding-agent harnesses. It does not replace Claude or Codex — it wraps them.

```
Claude Code / Codex SDK  =  execution plane
Auto-PM-Lite            =  control plane  (this repo)
```

The control plane owns:
- Which runtime (Claude or Codex) runs a task
- Which account, base URL, and model are used
- Which policy, sandbox, approval flow, and budget apply
- How child tasks are created, delegated, approved, and resumed
- Persistence via SQLite WAL

### Key Files

| File | Role |
|------|------|
| `src/orchestrator/orchestrator.ts` | Central service: task lifecycle, delegation, approval queue, event recording |
| `src/runtime/adapter.ts` | Interface all runtime adapters implement (`RuntimeAdapter`) |
| `src/runtime/claude.ts` | `@anthropic-ai/claude-agent-sdk` adapter |
| `src/runtime/codex.ts` | `@openai/codex-sdk` adapter |
| `src/mcp/auto-pm-service.ts` | Auto-PM MCP tool definitions (`delegate_to`, `request_capability`, etc.) |
| `src/mcp/stdio-server.ts` | MCP stdio server for Codex integration |
| `src/storage/db.ts` | SQLite WAL via `better-sqlite3`; tasks, turns, approvals, events, artifacts |
| `src/storage/event-store.ts` | Append-only normalized event buffer |
| `src/core/config.ts` | TOML config loader with Zod validation |
| `src/orchestrator/delegation.ts` | Delegation policy checks (depth, cycles, read-only enforcement) |
| `src/orchestrator/policy.ts` | Policy evaluation (approval requirements per kind) |

### Runtime Adapter Interface

Every runtime adapter must implement:

```ts
interface RuntimeAdapter {
  readonly runtime: RuntimeKind;
  startTask(input: StartRuntimeTaskInput): Promise<RuntimeTaskHandle>;
  runTurn(input: RunTurnInput): AsyncIterable<AgentEvent>;  // yields events as they occur
  resumeTask(input: ResumeRuntimeTaskInput): Promise<RuntimeTaskHandle>;
  cancelTask(taskId: string): Promise<void>;
  closeTask(taskId: string): Promise<void>;
}
```

Adapters are intentionally thin. They translate `Profile + Account + Policy + Workspace` into SDK-specific calls and normalize SDK events back to `AgentEvent`. Policy decisions stay in `Orchestrator`.

### MCP Integration (Cross-Harness Delegation)

The `AutoPmMcpService` is the bridge between runtimes. Both Claude and Codex use it to call orchestrator tools:

- `delegate_to` — spawn a child task on the other runtime
- `request_capability` — ask for elevated privileges (approval flow)
- `wait_for_task` / `get_task_result` — observe child task completion
- `report_artifact` — surface a generated artifact

Claude uses in-process MCP (`createSdkMcpServer()`). Codex connects via stdio (`runStdioMcpServer`).

### Data Model

Credentials live in `Account`, behavior rules in `Policy`, runtime config in `Profile`, and execution state in `Task`. Keys are never stored in profiles or tasks — only `secretRef` pointing to `env:NAME`.

### Config Files

```text
~/.auto-pm-lite/
  config.toml     # accounts, policies, profiles
  data.sqlite     # WAL-mode SQLite
```

Secrets use `env:VAR_NAME` references resolved at runtime. Never put raw keys in TOML.

### Approval Model

All privilege changes route through `Orchestrator.requestCapability()`. The parent agent is **never** the approval authority — the orchestrator (policy + user) decides.
