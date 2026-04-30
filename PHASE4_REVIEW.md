# Phase 0–4 Status Review (post-rework)

This document captures the actual state of the control plane after addressing the
review feedback in `typescript-multi-harness-agent-orchestrator-final.md` against the
companion notes in `cli-overview-console-claude-code-cli-co-lovely-nest.md`.

The 10 review points are listed verbatim, followed by what changed.

---

## 1. Claude permission model

- `read-only` profiles use `permissionMode: "dontAsk"` with a static `allowedTools` whitelist
  (`Read`, `Glob`, `Grep`). No `canUseTool` fallback — the SDK simply refuses anything else.
- `edit` and `full` profiles use `permissionMode: "default"` plus `canUseTool`, which routes
  every gated call through `Orchestrator.requestCapability`. Approvals are persisted, never
  decided by the parent agent.
- `acceptEdits` is documented in `src/orchestrator/policy.ts` as **intentionally not used**.
  It broadens file operations and weakens `canUseTool`. If a profile genuinely needs autopilot,
  it must be enabled explicitly as `unsafeAcceptEdits` later — never as the default.
- Edit-mode auto-approval now matches the full edit-tool family
  (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`) so a profile labelled `edit` does not
  require approvals for tools it implicitly authorises.

## 2. Codex provider injection

- `requiresCustomCodexProvider` decides whether to set `model_provider` /
  `model_providers.<id>` (`openai-compatible`, `openai-azure`).
- When a custom provider is in play, `baseUrl` is **never** also set at the top level —
  exactly one source of truth.
- Official `openai` accounts use Codex's default auth path — no `baseUrl`, no provider
  config.
- Provider IDs are sanitised into `[a-z0-9_]+`. The corresponding env key is sanitised by
  `sanitizeEnvKey` into `AUTO_PM_KEY_[A-Z0-9_]+` so account ids containing `-` / `.` are safe.

## 3. Workspace isolation

- `workspace.topLevelUseWorktree = true` is now the default in `src/core/config.ts`.
- Top-level tasks allocate a detached worktree under `workspace.rootDir` whenever the cwd
  is a git repo. Direct cwd is only used when (a) the cwd is not a repo, or (b) the user
  explicitly opts in via `unsafe_direct_cwd`.
- Editable child workspaces remain blocked by `assertReadOnlyDelegation` — Phase 5 work.

## 4. Transcript / prompt storage

- Default channel is `promptRedacted` (already in place).
- Optional second track: `promptRawEncrypted` + `promptRawTtlAt`, controlled via
  `transcript.storeRawEncrypted` and `transcript.rawTtlHours`.
- Encryption is AES-256-GCM with a key from `AUTO_PM_TRANSCRIPT_KEY` (base64 32 bytes or
  64-char hex). Helpers in `src/core/transcript.ts`. Tests cover encrypt/decrypt roundtrip,
  TTL, and missing-key fallback.

## 5. Cross-task reference policy

- `core/reference.ts` exposes `policyTrustLevel(policy)` to score a policy on a 0–3 scale
  derived from `permissionMode`, `sandboxMode`, and `networkAllowed`.
- `Orchestrator.delegateTask` runs `evaluateReferenceAccess` on every reference: lookup
  target task, check lineage / sameWorkspace / trust gates, deny with
  `reference_denied:<taskId>` or `reference_unknown:<taskId>` when the gate fails.
- Each successful expansion fires a `reference.expanded` event so audit can trace what a
  child saw and when.

## 6. Resume semantics

- `Task.status` covers `interrupted` and `reconcile_required`.
- `canResumeTask` enforces:
  - `backendThreadId` exists.
  - Status ∈ {`interrupted`, `reconcile_required`, `queued`, `awaiting_approval`}.
  - Workspace path still on disk.
  - **Zero pending approvals.**
  - Latest turn is not `running` — a half-completed turn forces reconciliation.
  - `reconcile_required` only resumes if the latest turn is in a terminal
    (`completed`/`failed`) state.

## 7. SQLite write pressure

- `EventStore` already serialises all writes through a single in-process queue with
  `maxQueueSize` and `flushBatchSize` knobs (see `src/storage/event-store.ts`).
- New: `AppDatabase.listEvents` + `Orchestrator.replayAndSubscribe` — events:stream now
  flushes the queue, drains historical events from SQLite, and only then attaches a live
  subscription. No duplication, no skipped events between the historical pull and the
  live attach.

## 8. MCP boundary

- MCP remains the agent-visible boundary only. Internal call paths (CLI, scheduler,
  approval-resume, event replay) talk to `Orchestrator` directly without round-tripping
  through MCP.

## 9. Approval taxonomy

- New `ApprovalCategory` union: `tool_approval`, `privilege_escalation`,
  `clarification`, `capability_request`.
- `categorizeApproval(kind)` maps each `ApprovalKind` into one of those four classes.
- `ApprovalKind` gained `clarification` so ask-user questions never collide with danger
  gates.
- `auto-pm-lite approval:list --category <category>` filters by class.

## 10. Verification discipline

- Codex `pnpm spike:codex:*`, Claude `spike:claude:*` and `pnpm test:live` are still the
  source of truth for behaviour. Pinned package versions and local fixtures, not external
  doc links, decide what works.

---

## Phase progression

### Phase 0 — SDK Spike

`spikes/` covers Claude `query()`/`canUseTool`/`createSdkMcpServer()`, Codex `runStreamed`/
`resumeThread`/MCP stdio. Live smoke gates remain a known caveat (Claude live still flows
through cc-wrapped login; Codex MCP non-interactive smoke still surfaces the cancelled
tool path). Both are accepted limitations — captured here, not new gaps to close.

### Phase 1 — Core Control Plane

- Config schema and `AppConfig` are aligned (`scheduler`, `rateLimit`, `transcript`,
  `storage`, `workspace`).
- `tsc --noEmit` clean, `pnpm test` green (61 tests).

### Phase 2 — Runtime Adapters

- Claude permission semantics rewritten per item 1.
- Codex provider injection rewritten per item 2.
- `BaseRuntimeAdapter.resolveSecretEnv` continues to gate secrets behind `sanitizeEnvKey`.

### Phase 3 — Read-Only Cross-Harness Delegation

- MCP service surface stable (`delegate_to`, `request_capability`, `wait_for_task`,
  `get_task_result`, `report_artifact`).
- Cross-task references now flow through the `ReferencePolicy` gate.
- Phase 3 fix: `buildCodexMcpServerEnv` now passes through env vars that exist as empty
  strings (test was asserting on this — it's also the safer behaviour for sub-process env
  fidelity).

### Phase 4 — Approvals / Budget / Concurrency

- Scheduler now **blocks** via `acquire(taskId, accountId)` — global and per-account limits
  are enforced before `runtime.startTask`. Wait queue is drained when slots free.
  Configurable via `scheduler.maxConcurrentTasksGlobal` /
  `scheduler.maxConcurrentTasksPerAccount`.
- Rate limiter wired into the same path; `rateLimit.enabled` toggles between
  `NoOpRateLimiter` and `TokenBucketRateLimiter`.
- Budget exceeded: task is auto-paused (`status = awaiting_approval`) and a
  `budget_increase` approval is created. Approving resets the in-task usage counters and
  flips the status back to `queued`. Denying leaves the task awaiting.
- Approvals carry a `category` field at the CLI; pending approvals expire automatically on
  list when `expiresAt` has passed.
- Event stream is dual-mode: live in-process pub/sub for low-latency, plus
  `replayAndSubscribe` for durable replay from SQLite.

### Tests

- 11 test files, 61 cases:
  - `tests/orchestrator/phase1.spec.ts` (9)
  - `tests/orchestrator/phase4.spec.ts` (14)
  - `tests/orchestrator/scheduler-queue.spec.ts` (3 — new)
  - `tests/orchestrator/approval-resume.spec.ts` (4 — new)
  - `tests/orchestrator/policy.spec.ts` (6)
  - `tests/orchestrator/workspace.spec.ts` (2)
  - `tests/mcp/phase3.spec.ts` (5)
  - `tests/storage/event-store.spec.ts` (2)
  - `tests/security/redaction.spec.ts` (3)
  - `tests/core/reference-policy.spec.ts` (8 — new)
  - `tests/core/transcript.spec.ts` (5 — new)

---

## Outstanding / deferred

- Phase 5 — editable child workspaces, merge/discard workflow, merge approval gating.
- Codex MCP live smoke that proves a tool call returns a non-cancelled result end-to-end.
- Replacing the env-key transcript bootstrap with a proper key store (OS keychain) when
  hardening for production.
