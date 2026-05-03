import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AppConfig, ApprovalKind, Task, TaskStatus, TurnRecord, Workspace } from "../core/types.js";

export type SqliteDatabase = InstanceType<typeof Database>;

export interface DatabaseOptions {
  dbPath: string;
  busyTimeoutMs: number;
}

export interface CreateTaskRecordInput {
  task: Task;
  workspace: Workspace;
}

export interface StoredTask {
  id: string;
  name?: string | undefined;
  profileId: string;
  runtime: Task["runtime"];
  cwd: string;
  workspaceId: string;
  parentTaskId?: string | undefined;
  delegationDepth: number;
  delegationChain: string[];
  backendThreadId?: string | undefined;
  status: TaskStatus;
  budget: Task["budget"];
  triggeredBy: Task["triggeredBy"];
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
}

export interface StoredTurn extends TurnRecord {}

export interface StoredApproval {
  id: string;
  taskId: string;
  parentTaskId?: string | undefined;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "expired";
  requestedAt: string;
  resolvedAt?: string | undefined;
  resolutionReason?: string | undefined;
  expiresAt?: string | undefined;
}

export interface StoredArtifact {
  id: string;
  taskId: string;
  kind: "file" | "blob" | "url";
  ref: string;
  description?: string | undefined;
  ts: string;
}

export class AppDatabase {
  readonly db: SqliteDatabase;

  constructor(options: DatabaseOptions) {
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  syncConfig(config: AppConfig): void {
    const upsertAccounts = this.db.prepare(`
      INSERT INTO accounts (id, vendor, base_url, secret_ref, extra_headers_json, extra_config_json, tags_json, updated_at)
      VALUES (@id, @vendor, @base_url, @secret_ref, @extra_headers_json, @extra_config_json, @tags_json, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        vendor = excluded.vendor,
        base_url = excluded.base_url,
        secret_ref = excluded.secret_ref,
        extra_headers_json = excluded.extra_headers_json,
        extra_config_json = excluded.extra_config_json,
        tags_json = excluded.tags_json,
        updated_at = excluded.updated_at
    `);

    const upsertPolicies = this.db.prepare(`
      INSERT INTO policies (id, config_json, updated_at)
      VALUES (@id, @config_json, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `);

    const upsertProfiles = this.db.prepare(`
      INSERT INTO profiles (id, runtime, account_id, policy_id, model, allowed_models_json, config_json, updated_at)
      VALUES (@id, @runtime, @account_id, @policy_id, @model, @allowed_models_json, @config_json, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        runtime = excluded.runtime,
        account_id = excluded.account_id,
        policy_id = excluded.policy_id,
        model = excluded.model,
        allowed_models_json = excluded.allowed_models_json,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `);

    const tx = this.db.transaction(() => {
      const updatedAt = new Date().toISOString();

      for (const account of Object.values(config.accounts)) {
        upsertAccounts.run({
          id: account.id,
          vendor: account.vendor,
          base_url: account.baseUrl ?? null,
          secret_ref: account.secretRef,
          extra_headers_json: JSON.stringify(account.extraHeaders ?? null),
          extra_config_json: JSON.stringify(account.extraConfig ?? null),
          tags_json: JSON.stringify(account.tags ?? []),
          updated_at: updatedAt,
        });
      }

      for (const policy of Object.values(config.policies)) {
        upsertPolicies.run({
          id: policy.id,
          config_json: JSON.stringify(policy),
          updated_at: updatedAt,
        });
      }

      for (const profile of Object.values(config.profiles)) {
        upsertProfiles.run({
          id: profile.id,
          runtime: profile.runtime,
          account_id: profile.accountId,
          policy_id: profile.policyId,
          model: profile.model,
          allowed_models_json: JSON.stringify(profile.allowedModels ?? []),
          config_json: JSON.stringify({
            systemPromptOverride: profile.systemPromptOverride,
            tags: profile.tags ?? [],
            ...(profile.runtime === "claude" ? { claudePermissionMode: profile.claudePermissionMode } : {}),
            ...(profile.runtime === "codex" ? {
              codexSandboxMode: profile.codexSandboxMode,
              codexApprovalPolicy: profile.codexApprovalPolicy,
              codexNetworkAccessEnabled: profile.codexNetworkAccessEnabled,
            } : {}),
          }),
          updated_at: updatedAt,
        });
      }
    });

    tx();
  }

  createTaskRecord(input: CreateTaskRecordInput): void {
    const insertWorkspace = this.db.prepare(`
      INSERT INTO workspaces (
        id, repo_root, path, branch, head, dirty, base_ref, parent_workspace_id,
        status, unsafe_direct_cwd, created_at, merge_requested_at, merge_approval_id,
        merged_at, discarded_at, merge_error_json
      )
      VALUES (
        @id, @repo_root, @path, @branch, @head, @dirty, @base_ref, @parent_workspace_id,
        @status, @unsafe_direct_cwd, @created_at, @merge_requested_at, @merge_approval_id,
        @merged_at, @discarded_at, @merge_error_json
      )
    `);

    const insertTask = this.db.prepare(`
      INSERT INTO tasks (id, name, profile_id, runtime, parent_task_id, delegation_depth, delegation_chain_json, backend_thread_id, workspace_id, cwd, status, budget_json, triggered_by, created_at, updated_at, completed_at)
      VALUES (@id, @name, @profile_id, @runtime, @parent_task_id, @delegation_depth, @delegation_chain_json, @backend_thread_id, @workspace_id, @cwd, @status, @budget_json, @triggered_by, @created_at, @updated_at, @completed_at)
    `);

    const tx = this.db.transaction(() => {
      insertWorkspace.run({
        id: input.workspace.id,
        repo_root: input.workspace.repoRoot ?? null,
        path: input.workspace.path,
        branch: input.workspace.branch ?? null,
        head: input.workspace.head ?? null,
        dirty: input.workspace.dirty === undefined ? null : input.workspace.dirty ? 1 : 0,
        base_ref: input.workspace.baseRef ?? null,
        parent_workspace_id: input.workspace.parentWorkspaceId ?? null,
        status: input.workspace.status,
        unsafe_direct_cwd: input.workspace.unsafeDirectCwd ? 1 : 0,
        created_at: input.workspace.createdAt,
        merge_requested_at: input.workspace.mergeRequestedAt ?? null,
        merge_approval_id: input.workspace.mergeApprovalId ?? null,
        merged_at: input.workspace.mergedAt ?? null,
        discarded_at: input.workspace.discardedAt ?? null,
        merge_error_json: input.workspace.mergeError ? JSON.stringify(input.workspace.mergeError) : null,
      });

      insertTask.run({
        id: input.task.id,
        name: input.task.name ?? null,
        profile_id: input.task.profileId,
        runtime: input.task.runtime,
        parent_task_id: input.task.parentTaskId ?? null,
        delegation_depth: input.task.delegationDepth,
        delegation_chain_json: JSON.stringify(input.task.delegationChain),
        backend_thread_id: input.task.backendThreadId ?? null,
        workspace_id: input.task.workspaceId,
        cwd: input.task.cwd,
        status: input.task.status,
        budget_json: JSON.stringify(input.task.budget),
        triggered_by: input.task.triggeredBy,
        created_at: input.task.createdAt,
        updated_at: input.task.updatedAt,
        completed_at: input.task.completedAt ?? null,
      });
    });

    tx();
  }

  listTasks(): Array<{
    id: string;
    name: string | null;
    profileId: string;
    runtime: string;
    status: string;
    cwd: string;
    parentTaskId?: string | undefined;
    delegationDepth: number;
    triggeredBy: string;
    createdAt: string;
  }> {
    const rows = this.db.prepare(`
      SELECT id, name, profile_id, runtime, parent_task_id, delegation_depth, status, cwd, triggered_by, created_at
      FROM tasks
      ORDER BY created_at DESC
    `).all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      name: row.name === null ? null : String(row.name),
      profileId: String(row.profile_id),
      runtime: String(row.runtime),
      status: String(row.status),
      cwd: String(row.cwd),
      ...(row.parent_task_id === null ? {} : { parentTaskId: String(row.parent_task_id) }),
      delegationDepth: Number(row.delegation_depth),
      triggeredBy: String(row.triggered_by),
      createdAt: String(row.created_at),
    }));
  }

  listTasksByStatus(status: TaskStatus): StoredTask[] {
    const rows = this.db.prepare(`
      SELECT id
      FROM tasks
      WHERE status = ?
      ORDER BY updated_at ASC
    `).all(status) as Array<{ id: string }>;

    return rows
      .map((row) => this.getTask(row.id))
      .filter((task): task is StoredTask => Boolean(task));
  }

  getTask(taskId: string): StoredTask | null {
    const row = this.db.prepare(`
      SELECT id, name, profile_id, runtime, cwd, workspace_id, parent_task_id, delegation_depth, delegation_chain_json, backend_thread_id, status, budget_json, triggered_by, created_at, updated_at, completed_at
      FROM tasks
      WHERE id = ?
    `).get(taskId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      ...(row.name === null ? {} : { name: String(row.name) }),
      profileId: String(row.profile_id),
      runtime: String(row.runtime) as Task["runtime"],
      cwd: String(row.cwd),
      workspaceId: String(row.workspace_id),
      ...(row.parent_task_id === null ? {} : { parentTaskId: String(row.parent_task_id) }),
      delegationDepth: Number(row.delegation_depth),
      delegationChain: JSON.parse(String(row.delegation_chain_json)) as string[],
      ...(row.backend_thread_id === null ? {} : { backendThreadId: String(row.backend_thread_id) }),
      status: String(row.status) as TaskStatus,
      budget: JSON.parse(String(row.budget_json)) as Task["budget"],
      triggeredBy: String(row.triggered_by) as Task["triggeredBy"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.completed_at === null ? {} : { completedAt: String(row.completed_at) }),
    };
  }

  updateTaskRuntimeState(input: {
    taskId: string;
    status: TaskStatus;
    backendThreadId?: string | undefined;
    completedAt?: string | undefined;
    updatedAt: string;
  }): void {
    this.db.prepare(`
      UPDATE tasks
      SET status = @status,
          backend_thread_id = COALESCE(@backend_thread_id, backend_thread_id),
          updated_at = @updated_at,
          completed_at = @completed_at
      WHERE id = @task_id
    `).run({
      task_id: input.taskId,
      status: input.status,
      backend_thread_id: input.backendThreadId ?? null,
      updated_at: input.updatedAt,
      completed_at: input.completedAt ?? null,
    });
  }

  updateTaskBudget(taskId: string, budget: Task["budget"]): void {
    this.db.prepare(`
      UPDATE tasks
      SET budget_json = @budget_json,
          updated_at = @updated_at
      WHERE id = @task_id
    `).run({
      task_id: taskId,
      budget_json: JSON.stringify(budget),
      updated_at: new Date().toISOString(),
    });
  }

  createTurn(turn: StoredTurn): void {
    this.db.prepare(`
      INSERT INTO turns (id, task_id, prompt_redacted, prompt_raw_encrypted, prompt_raw_ttl_at, status, usage_json, started_at, completed_at)
      VALUES (@id, @task_id, @prompt_redacted, @prompt_raw_encrypted, @prompt_raw_ttl_at, @status, @usage_json, @started_at, @completed_at)
    `).run({
      id: turn.id,
      task_id: turn.taskId,
      prompt_redacted: turn.promptRedacted,
      prompt_raw_encrypted: turn.promptRawEncrypted ?? null,
      prompt_raw_ttl_at: turn.promptRawTtlAt ?? null,
      status: turn.status,
      usage_json: turn.usage ? JSON.stringify(turn.usage) : null,
      started_at: turn.startedAt,
      completed_at: turn.completedAt ?? null,
    });
  }

  updateTurn(input: {
    turnId: string;
    status: StoredTurn["status"];
    usage?: StoredTurn["usage"];
    completedAt?: string | undefined;
  }): void {
    this.db.prepare(`
      UPDATE turns
      SET status = @status,
          usage_json = @usage_json,
          completed_at = @completed_at
      WHERE id = @turn_id
    `).run({
      turn_id: input.turnId,
      status: input.status,
      usage_json: input.usage ? JSON.stringify(input.usage) : null,
      completed_at: input.completedAt ?? null,
    });
  }

  getLatestTurn(taskId: string): StoredTurn | null {
    const row = this.db.prepare(`
      SELECT id, task_id, prompt_redacted, prompt_raw_encrypted, prompt_raw_ttl_at, status, usage_json, started_at, completed_at
      FROM turns
      WHERE task_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(taskId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      taskId: String(row.task_id),
      promptRedacted: String(row.prompt_redacted),
      ...(row.prompt_raw_encrypted === null ? {} : { promptRawEncrypted: String(row.prompt_raw_encrypted) }),
      ...(row.prompt_raw_ttl_at === null ? {} : { promptRawTtlAt: String(row.prompt_raw_ttl_at) }),
      status: String(row.status) as StoredTurn["status"],
      ...(row.usage_json === null ? {} : { usage: JSON.parse(String(row.usage_json)) as NonNullable<StoredTurn["usage"]> }),
      startedAt: String(row.started_at),
      ...(row.completed_at === null ? {} : { completedAt: String(row.completed_at) }),
    };
  }

  listTurns(taskId: string): StoredTurn[] {
    const rows = this.db.prepare(`
      SELECT id, task_id, prompt_redacted, prompt_raw_encrypted, prompt_raw_ttl_at, status, usage_json, started_at, completed_at
      FROM turns
      WHERE task_id = ?
      ORDER BY started_at ASC
    `).all(taskId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      promptRedacted: String(row.prompt_redacted),
      ...(row.prompt_raw_encrypted === null ? {} : { promptRawEncrypted: String(row.prompt_raw_encrypted) }),
      ...(row.prompt_raw_ttl_at === null ? {} : { promptRawTtlAt: String(row.prompt_raw_ttl_at) }),
      status: String(row.status) as StoredTurn["status"],
      ...(row.usage_json === null ? {} : { usage: JSON.parse(String(row.usage_json)) as NonNullable<StoredTurn["usage"]> }),
      startedAt: String(row.started_at),
      ...(row.completed_at === null ? {} : { completedAt: String(row.completed_at) }),
    }));
  }

  createApproval(input: StoredApproval): void {
    this.db.prepare(`
      INSERT INTO approvals (id, task_id, parent_task_id, kind, payload_json, status, requested_at, resolved_at, resolution_reason, expires_at)
      VALUES (@id, @task_id, @parent_task_id, @kind, @payload_json, @status, @requested_at, @resolved_at, @resolution_reason, @expires_at)
    `).run({
      id: input.id,
      task_id: input.taskId,
      parent_task_id: input.parentTaskId ?? null,
      kind: input.kind,
      payload_json: JSON.stringify(input.payload),
      status: input.status,
      requested_at: input.requestedAt,
      resolved_at: input.resolvedAt ?? null,
      resolution_reason: input.resolutionReason ?? null,
      expires_at: input.expiresAt ?? null,
    });
  }

  resolveApproval(input: {
    approvalId: string;
    status: StoredApproval["status"];
    resolvedAt: string;
    resolutionReason?: string | undefined;
  }): void {
    this.db.prepare(`
      UPDATE approvals
      SET status = @status,
          resolved_at = @resolved_at,
          resolution_reason = @resolution_reason
      WHERE id = @approval_id
    `).run({
      approval_id: input.approvalId,
      status: input.status,
      resolved_at: input.resolvedAt,
      resolution_reason: input.resolutionReason ?? null,
    });
  }

  expireApprovals(approvalIds: string[], now: string): void {
    if (approvalIds.length === 0) {
      return;
    }

    const placeholders = approvalIds.map(() => "?").join(",");
    this.db.prepare(`
      UPDATE approvals
      SET status = 'expired',
          resolved_at = ?
      WHERE id IN (${placeholders}) AND status = 'pending'
    `).run(now, ...approvalIds);
  }

  listApprovals(taskId?: string): StoredApproval[] {
    const baseQuery = `
      SELECT id, task_id, parent_task_id, kind, payload_json, status, requested_at, resolved_at, resolution_reason, expires_at
      FROM approvals
      ${taskId ? "WHERE task_id = ?" : ""}
      ORDER BY requested_at ASC
    `;
    const rows = (taskId
      ? this.db.prepare(baseQuery).all(taskId)
      : this.db.prepare(baseQuery).all()) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      ...(row.parent_task_id === null ? {} : { parentTaskId: String(row.parent_task_id) }),
      kind: String(row.kind) as StoredApproval["kind"],
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      status: String(row.status) as StoredApproval["status"],
      requestedAt: String(row.requested_at),
      ...(row.resolved_at === null ? {} : { resolvedAt: String(row.resolved_at) }),
      ...(row.resolution_reason === null ? {} : { resolutionReason: String(row.resolution_reason) }),
      ...(row.expires_at === null ? {} : { expiresAt: String(row.expires_at) }),
    }));
  }

  listPendingApprovals(taskId: string): StoredApproval[] {
    const rows = this.db.prepare(`
      SELECT id, task_id, parent_task_id, kind, payload_json, status, requested_at, resolved_at, resolution_reason, expires_at
      FROM approvals
      WHERE task_id = ? AND status = 'pending'
      ORDER BY requested_at ASC
    `).all(taskId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      ...(row.parent_task_id === null ? {} : { parentTaskId: String(row.parent_task_id) }),
      kind: String(row.kind) as StoredApproval["kind"],
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      status: "pending",
      requestedAt: String(row.requested_at),
      ...(row.expires_at === null ? {} : { expiresAt: String(row.expires_at) }),
    }));
  }

  createArtifact(input: StoredArtifact): void {
    this.db.prepare(`
      INSERT INTO artifacts (id, task_id, kind, ref, description, ts)
      VALUES (@id, @task_id, @kind, @ref, @description, @ts)
    `).run({
      id: input.id,
      task_id: input.taskId,
      kind: input.kind,
      ref: input.ref,
      description: input.description ?? null,
      ts: input.ts,
    });
  }

  listArtifacts(taskId: string): StoredArtifact[] {
    const rows = this.db.prepare(`
      SELECT id, task_id, kind, ref, description, ts
      FROM artifacts
      WHERE task_id = ?
      ORDER BY ts ASC
    `).all(taskId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      kind: String(row.kind) as StoredArtifact["kind"],
      ref: String(row.ref),
      ...(row.description === null ? {} : { description: String(row.description) }),
      ts: String(row.ts),
    }));
  }

  getLatestCompletedMessage(taskId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM events
      WHERE task_id = ? AND type = 'message.completed'
      ORDER BY id DESC
      LIMIT 1
    `).get(taskId) as { payload_json: string } | undefined;

    if (!row) {
      return undefined;
    }

    const payload = JSON.parse(row.payload_json) as { text?: unknown };
    return typeof payload.text === "string" ? payload.text : undefined;
  }

  listEvents(input: { taskId?: string | undefined; afterId?: number | undefined; limit?: number | undefined }): Array<{ id: number; taskId: string; turnId: string | null; type: string; payload: Record<string, unknown>; ts: string }> {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (input.taskId) {
      filters.push("task_id = ?");
      params.push(input.taskId);
    }
    if (input.afterId !== undefined) {
      filters.push("id > ?");
      params.push(input.afterId);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const limit = input.limit && input.limit > 0 ? input.limit : 1000;
    const rows = this.db.prepare(`
      SELECT id, task_id, turn_id, type, payload_json, ts
      FROM events
      ${where}
      ORDER BY id ASC
      LIMIT ${limit}
    `).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      type: String(row.type),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      ts: String(row.ts),
    }));
  }

  insertFileChange(input: {
    taskId: string;
    workspaceId: string;
    path: string;
    changeKind: "create" | "modify" | "delete";
    ts: string;
  }): void {
    this.db.prepare(`
      INSERT INTO file_changes (task_id, workspace_id, path, change_kind, ts)
      VALUES (@task_id, @workspace_id, @path, @change_kind, @ts)
    `).run({
      task_id: input.taskId,
      workspace_id: input.workspaceId,
      path: input.path,
      change_kind: input.changeKind,
      ts: input.ts,
    });
  }

  getWorkspace(workspaceId: string): Workspace | null {
    const row = this.db.prepare(`
      SELECT id, repo_root, path, branch, head, dirty, base_ref, parent_workspace_id, status, unsafe_direct_cwd, created_at, merge_requested_at, merge_approval_id, merged_at, discarded_at, merge_error_json
      FROM workspaces
      WHERE id = ?
    `).get(workspaceId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      path: String(row.path),
      ...(row.repo_root === null ? {} : { repoRoot: String(row.repo_root) }),
      ...(row.branch === null ? {} : { branch: String(row.branch) }),
      ...(row.head === null ? {} : { head: String(row.head) }),
      ...(row.dirty === null ? {} : { dirty: Boolean(row.dirty) }),
      ...(row.base_ref === null ? {} : { baseRef: String(row.base_ref) }),
      ...(row.parent_workspace_id === null ? {} : { parentWorkspaceId: String(row.parent_workspace_id) }),
      status: String(row.status) as Workspace["status"],
      unsafeDirectCwd: Boolean(row.unsafe_direct_cwd),
      createdAt: String(row.created_at),
      ...(row.merge_requested_at === null ? {} : { mergeRequestedAt: String(row.merge_requested_at) }),
      ...(row.merge_approval_id === null ? {} : { mergeApprovalId: String(row.merge_approval_id) }),
      ...(row.merged_at === null ? {} : { mergedAt: String(row.merged_at) }),
      ...(row.discarded_at === null ? {} : { discardedAt: String(row.discarded_at) }),
      ...(row.merge_error_json === null ? {} : { mergeError: JSON.parse(String(row.merge_error_json)) as Workspace["mergeError"] }),
    };
  }

  updateWorkspaceLifecycle(input: {
    workspaceId: string;
    status: Workspace["status"];
    head?: string | undefined;
    dirty?: boolean | undefined;
    mergeRequestedAt?: string | null | undefined;
    mergeApprovalId?: string | null | undefined;
    mergedAt?: string | null | undefined;
    discardedAt?: string | null | undefined;
    mergeError?: Workspace["mergeError"] | null | undefined;
  }): void {
    this.db.prepare(`
      UPDATE workspaces
      SET status = @status,
          head = COALESCE(@head, head),
          dirty = COALESCE(@dirty, dirty),
          merge_requested_at = CASE WHEN @merge_requested_at_set THEN @merge_requested_at ELSE merge_requested_at END,
          merge_approval_id = CASE WHEN @merge_approval_id_set THEN @merge_approval_id ELSE merge_approval_id END,
          merged_at = CASE WHEN @merged_at_set THEN @merged_at ELSE merged_at END,
          discarded_at = CASE WHEN @discarded_at_set THEN @discarded_at ELSE discarded_at END,
          merge_error_json = CASE WHEN @merge_error_set THEN @merge_error_json ELSE merge_error_json END
      WHERE id = @workspace_id
    `).run({
      workspace_id: input.workspaceId,
      status: input.status,
      head: input.head ?? null,
      dirty: input.dirty === undefined ? null : input.dirty ? 1 : 0,
      merge_requested_at_set: input.mergeRequestedAt !== undefined ? 1 : 0,
      merge_requested_at: input.mergeRequestedAt ?? null,
      merge_approval_id_set: input.mergeApprovalId !== undefined ? 1 : 0,
      merge_approval_id: input.mergeApprovalId ?? null,
      merged_at_set: input.mergedAt !== undefined ? 1 : 0,
      merged_at: input.mergedAt ?? null,
      discarded_at_set: input.discardedAt !== undefined ? 1 : 0,
      discarded_at: input.discardedAt ?? null,
      merge_error_set: input.mergeError !== undefined ? 1 : 0,
      merge_error_json: input.mergeError ? JSON.stringify(input.mergeError) : null,
    });
  }

  getProfile(profileId: string): { id: string; runtime: string; policyId: string } | null {
    const row = this.db.prepare(`
      SELECT id, runtime, policy_id
      FROM profiles
      WHERE id = ?
    `).get(profileId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      runtime: String(row.runtime),
      policyId: String(row.policy_id),
    };
  }

  getPolicy(policyId: string): Record<string, unknown> | null {
    const row = this.db.prepare(`
      SELECT config_json
      FROM policies
      WHERE id = ?
    `).get(policyId) as { config_json: string } | undefined;

    return row ? JSON.parse(row.config_json) as Record<string, unknown> : null;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        vendor TEXT NOT NULL,
        base_url TEXT,
        secret_ref TEXT NOT NULL,
        extra_headers_json TEXT,
        extra_config_json TEXT,
        tags_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        policy_id TEXT NOT NULL REFERENCES policies(id),
        model TEXT NOT NULL,
        allowed_models_json TEXT,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        repo_root TEXT,
        path TEXT NOT NULL,
        branch TEXT,
        head TEXT,
        dirty INTEGER,
        base_ref TEXT,
        parent_workspace_id TEXT REFERENCES workspaces(id),
        status TEXT NOT NULL,
        unsafe_direct_cwd INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT,
        profile_id TEXT NOT NULL REFERENCES profiles(id),
        runtime TEXT NOT NULL,
        parent_task_id TEXT REFERENCES tasks(id),
        delegation_depth INTEGER NOT NULL,
        delegation_chain_json TEXT NOT NULL,
        backend_thread_id TEXT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        prompt_redacted TEXT NOT NULL,
        prompt_raw_encrypted TEXT,
        prompt_raw_ttl_at TEXT,
        status TEXT NOT NULL,
        usage_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        turn_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task_ts ON events(task_id, ts);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        parent_task_id TEXT REFERENCES tasks(id),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_reason TEXT,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS file_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        path TEXT NOT NULL,
        change_kind TEXT NOT NULL,
        ts TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        description TEXT,
        ts TEXT NOT NULL
      );
    `);
    this.ensureColumn("workspaces", "head", "TEXT");
    this.ensureColumn("workspaces", "dirty", "INTEGER");
    this.ensureColumn("workspaces", "merge_requested_at", "TEXT");
    this.ensureColumn("workspaces", "merge_approval_id", "TEXT");
    this.ensureColumn("workspaces", "merged_at", "TEXT");
    this.ensureColumn("workspaces", "discarded_at", "TEXT");
    this.ensureColumn("workspaces", "merge_error_json", "TEXT");
    this.recordMigration("001_initial");
    this.recordMigration("002_workspace_lifecycle");
  }

  private ensureColumn(tableName: string, columnName: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${type}`);
    }
  }

  private recordMigration(id: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO schema_migrations (id, applied_at)
      VALUES (?, ?)
    `).run(id, new Date().toISOString());
  }
}
