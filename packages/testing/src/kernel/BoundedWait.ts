export type WaitBudget = Readonly<{ readonly steps: number; readonly ms?: number }>;
export class BoundedWaitError extends Error { readonly code = "WAIT_BUDGET_EXHAUSTED"; constructor(readonly budget: WaitBudget) { super("bounded wait budget exhausted"); this.name = "BoundedWaitError"; } }
export const boundedWait = async <T>(budget: WaitBudget, operation: (remaining: Readonly<{ readonly steps: number }>) => T | Promise<T>): Promise<T> => {
  if (!Number.isInteger(budget.steps) || budget.steps < 1 || (budget.ms !== undefined && (!Number.isFinite(budget.ms) || budget.ms < 0))) throw new BoundedWaitError(budget);
  let steps = budget.steps;
  while (steps-- > 0) {
    const attempt = Promise.resolve().then(() => operation({ steps }));
    if (budget.ms === undefined) return await attempt;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new BoundedWaitError(budget)), budget.ms);
    });
    try { return await Promise.race([attempt, deadline]); }
    finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
  throw new BoundedWaitError(budget);
};
