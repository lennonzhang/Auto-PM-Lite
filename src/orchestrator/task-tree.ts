export function nextDelegationDepth(parentDepth: number): number {
  return parentDepth + 1;
}

export function buildDelegationChain(parentChain: string[], parentTaskId: string): string[] {
  return [...parentChain, parentTaskId];
}

export function wouldCreateCycle(chain: string[], candidateTaskId: string): boolean {
  return chain.includes(candidateTaskId);
}
