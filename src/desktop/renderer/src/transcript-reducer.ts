import type {
  AgentItem,
  ApprovalView,
  EventEnvelope,
  ItemKind,
  ItemPatch,
  ItemPayload,
} from "../../../core/events.js";
import type { BudgetSnapshot } from "../../../core/types.js";

export interface TaskViewModel {
  taskId: string;
  status?: string | undefined;
  items: Map<string, AgentItem>;
  rootItemOrder: string[];
  childrenByParentId: Map<string, string[]>;
  pendingApprovals: Map<string, ApprovalView>;
  notices: Array<AgentItem<"system_notice">>;
  budget: BudgetSnapshot;
  lastGlobalSeq: number;
  lastTaskSeq: number;
  resyncRequired: boolean;
}

export function createTaskViewModel(taskId: string): TaskViewModel {
  return {
    taskId,
    items: new Map(),
    rootItemOrder: [],
    childrenByParentId: new Map(),
    pendingApprovals: new Map(),
    notices: [],
    budget: {},
    lastGlobalSeq: 0,
    lastTaskSeq: 0,
    resyncRequired: false,
  };
}

export function reduceTaskView(input: TaskViewModel, env: EventEnvelope): TaskViewModel {
  if (env.taskId !== input.taskId || env.taskSeq <= input.lastTaskSeq) {
    return input;
  }

  let vm = cloneView(input);
  vm.lastGlobalSeq = Math.max(vm.lastGlobalSeq, env.seq);
  vm.lastTaskSeq = env.taskSeq;

  const event = env.event;
  switch (event.kind) {
    case "task.queued":
      vm.status = "queued";
      return vm;
    case "task.started":
      vm.status = "running";
      return vm;
    case "task.paused":
      vm.status = "paused";
      return vm;
    case "task.cancelled":
      vm.status = "interrupted";
      return vm;
    case "task.idle":
      vm.status = "idle";
      return vm;
    case "task.closed":
      vm.status = "closed";
      return vm;
    case "task.failed":
      vm.status = "failed";
      return vm;
    case "task.interrupted":
      vm.status = "interrupted";
      return vm;
    case "budget.warning":
    case "budget.exceeded":
      vm.budget = { ...event.budget };
      return vm;
    case "approval.requested":
      vm.pendingApprovals.set(event.approval.id, event.approval);
      return vm;
    case "approval.resolved": {
      const approval = vm.pendingApprovals.get(event.approvalId);
      if (approval) {
        vm.pendingApprovals.set(event.approvalId, {
          ...approval,
          status: event.approved ? "approved" : "denied",
          ...(event.reason ? { resolutionReason: event.reason } : {}),
        });
      }
      return vm;
    }
    case "item.started":
      return insertItem(vm, event.item);
    case "item.updated":
      return updateItem(vm, event.itemId, (item) => applyPatch(vm, item, event.patch));
    case "item.completed":
      return updateItem(vm, event.itemId, (item) => ({
        ...item,
        status: "completed",
        updatedAt: event.completedAt,
        completedAt: event.completedAt,
        payload: event.finalPayload as ItemPayload[ItemKind],
      }));
    case "item.failed":
      return updateItem(vm, event.itemId, (item) => ({
        ...item,
        status: "failed",
        updatedAt: event.completedAt,
        completedAt: event.completedAt,
        error: event.error,
      }));
    case "item.cancelled":
      return updateItem(vm, event.itemId, (item) => ({
        ...item,
        status: "cancelled",
        updatedAt: event.completedAt,
        completedAt: event.completedAt,
      }));
    default:
      return vm;
  }
}

export function reduceTaskEvents(taskId: string, events: EventEnvelope[]): TaskViewModel {
  return events.reduce((vm, event) => reduceTaskView(vm, event), createTaskViewModel(taskId));
}

function cloneView(input: TaskViewModel): TaskViewModel {
  return {
    ...input,
    items: new Map(input.items),
    rootItemOrder: [...input.rootItemOrder],
    childrenByParentId: new Map(Array.from(input.childrenByParentId.entries()).map(([key, value]) => [key, [...value]])),
    pendingApprovals: new Map(input.pendingApprovals),
    notices: [...input.notices],
    budget: { ...input.budget },
  };
}

function insertItem(vm: TaskViewModel, item: AgentItem): TaskViewModel {
  vm.items.set(item.id, item);
  if (item.parentItemId) {
    const children = vm.childrenByParentId.get(item.parentItemId) ?? [];
    if (!children.includes(item.id)) {
      children.push(item.id);
    }
    vm.childrenByParentId.set(item.parentItemId, children);
  } else if (!vm.rootItemOrder.includes(item.id)) {
    vm.rootItemOrder.push(item.id);
  }
  if (item.kind === "system_notice") {
    vm.notices.push(item as AgentItem<"system_notice">);
  }
  return vm;
}

function updateItem(vm: TaskViewModel, itemId: string, update: (item: AgentItem) => AgentItem): TaskViewModel {
  const current = vm.items.get(itemId);
  if (!current) {
    vm.resyncRequired = true;
    return vm;
  }
  const next = update(current);
  vm.items.set(itemId, next);
  if (next.kind === "system_notice") {
    vm.notices = vm.notices.map((notice) => notice.id === itemId ? next as AgentItem<"system_notice"> : notice);
  }
  return vm;
}

function applyPatch(vm: TaskViewModel, item: AgentItem, patch: ItemPatch): AgentItem {
  switch (patch.op) {
    case "append_text": {
      if (item.kind !== "assistant_message" && item.kind !== "user_message") {
        vm.resyncRequired = true;
        return item;
      }
      const narrowed = item as AgentItem<"assistant_message"> | AgentItem<"user_message">;
      const currentText = narrowed.payload.text;
      if (currentText.length !== patch.baseLength) {
        vm.resyncRequired = true;
        return item;
      }
      return {
        ...narrowed,
        payload: {
          ...narrowed.payload,
          text: currentText + patch.value,
        },
      } as AgentItem;
    }
    case "append_array_text": {
      if (item.kind !== "reasoning") {
        vm.resyncRequired = true;
        return item;
      }
      const narrowed = item as AgentItem<"reasoning">;
      const key = patch.path === "payload.summary" ? "summary" : "content";
      const values = [...narrowed.payload[key]];
      const current = values[patch.index] ?? "";
      if (current.length !== patch.baseLength) {
        vm.resyncRequired = true;
        return item;
      }
      values[patch.index] = current + patch.value;
      return {
        ...narrowed,
        payload: {
          ...narrowed.payload,
          [key]: values,
        },
      } as AgentItem;
    }
    case "append_command_output": {
      if (item.kind !== "command_execution") {
        vm.resyncRequired = true;
        return item;
      }
      const narrowed = item as AgentItem<"command_execution">;
      if (narrowed.payload.aggregatedOutput.length !== patch.baseLength) {
        vm.resyncRequired = true;
        return item;
      }
      return {
        ...narrowed,
        payload: {
          ...narrowed.payload,
          aggregatedOutput: narrowed.payload.aggregatedOutput + patch.value.text,
          outputChunks: [...narrowed.payload.outputChunks, patch.value],
        },
      } as AgentItem;
    }
    case "append_tool_input_json": {
      if (item.kind !== "tool_call") {
        vm.resyncRequired = true;
        return item;
      }
      const narrowed = item as AgentItem<"tool_call">;
      const current = narrowed.payload.inputText ?? "";
      if (current.length !== patch.baseLength) {
        vm.resyncRequired = true;
        return item;
      }
      return {
        ...narrowed,
        payload: {
          ...narrowed.payload,
          inputText: current + patch.value,
          input: patch.partialParsed ?? narrowed.payload.input,
        },
      } as AgentItem;
    }
    case "merge_payload":
      return {
        ...item,
        payload: {
          ...(item.payload as object),
          ...patch.value,
        },
      } as AgentItem;
    case "replace_payload":
      if (item.kind !== patch.itemKind) {
        vm.resyncRequired = true;
        return item;
      }
      return {
        ...item,
        payload: patch.value as ItemPayload[ItemKind],
      } as AgentItem;
    case "set_status":
      return {
        ...item,
        status: patch.status,
      };
    case "set_tool_phase":
      if (item.kind !== "tool_call") {
        vm.resyncRequired = true;
        return item;
      }
      const narrowed = item as AgentItem<"tool_call">;
      return {
        ...narrowed,
        payload: {
          ...narrowed.payload,
          phase: patch.phase,
        },
      } as AgentItem;
  }
}
