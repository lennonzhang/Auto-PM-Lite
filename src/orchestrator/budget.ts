import type { BudgetSnapshot, Policy, TurnUsage } from "../core/types.js";

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

export function checkBudget(current: BudgetSnapshot, policy: Policy, proposedUsage?: TurnUsage): BudgetCheckResult {
  const projected = proposedUsage ? projectBudget(current, proposedUsage) : current;

  if (policy.maxTokens && projected.inputTokens !== undefined && projected.outputTokens !== undefined) {
    const totalTokens = projected.inputTokens + projected.outputTokens;
    if (totalTokens > policy.maxTokens) {
      return {
        allowed: false,
        reason: `Token budget exceeded: ${totalTokens} > ${policy.maxTokens}`,
      };
    }
    if (totalTokens > policy.maxTokens * 0.9) {
      return {
        allowed: true,
        warning: `Token budget at ${Math.round((totalTokens / policy.maxTokens) * 100)}%`,
      };
    }
  }

  if (policy.maxCostUsd && projected.estimatedCostUsd !== undefined) {
    if (projected.estimatedCostUsd > policy.maxCostUsd) {
      return {
        allowed: false,
        reason: `Cost budget exceeded: $${projected.estimatedCostUsd.toFixed(4)} > $${policy.maxCostUsd.toFixed(4)}`,
      };
    }
    if (projected.estimatedCostUsd > policy.maxCostUsd * 0.9) {
      return {
        allowed: true,
        warning: `Cost budget at ${Math.round((projected.estimatedCostUsd / policy.maxCostUsd) * 100)}%`,
      };
    }
  }

  return { allowed: true };
}

export function projectBudget(current: BudgetSnapshot, usage: TurnUsage): BudgetSnapshot {
  return {
    maxTokens: current.maxTokens,
    maxCostUsd: current.maxCostUsd,
    inputTokens: (current.inputTokens ?? 0) + (usage.inputTokens ?? 0),
    outputTokens: (current.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    estimatedCostUsd: (current.estimatedCostUsd ?? 0) + (usage.costUsd ?? 0),
  };
}

export function updateBudget(current: BudgetSnapshot, usage: TurnUsage): BudgetSnapshot {
  return projectBudget(current, usage);
}
