export type EffectOutcome = Readonly<{
  readonly kind: "succeed" | "fail" | "duplicate" | "hang";
  readonly value?: unknown;
}>;
export type EffectRequest = Readonly<{ readonly id: string; readonly name: string; readonly input?: unknown }>;
export class EffectLedger {
  private readonly requests: EffectRequest[] = [];
  private readonly outcomes = new Map<string, EffectOutcome>();
  private readonly journal = new Map<string, number>();
  request(request: EffectRequest): void {
    this.requests.push(Object.freeze({ ...request }));
  }
  resolve(id: string, outcome: EffectOutcome): void {
    this.outcomes.set(id, Object.freeze({ ...outcome }));
  }
  get(id: string): EffectOutcome | undefined {
    return this.outcomes.get(id);
  }
  recordJournal(id: string): void {
    this.journal.set(id, (this.journal.get(id) ?? 0) + 1);
  }
  journalCount(id: string): number {
    return this.journal.get(id) ?? 0;
  }
  snapshot(): Readonly<{
    readonly requests: readonly EffectRequest[];
    readonly outcomes: Readonly<Record<string, EffectOutcome>>;
    readonly journal: Readonly<Record<string, number>>;
  }> {
    return {
      requests: [...this.requests],
      outcomes: Object.fromEntries(this.outcomes),
      journal: Object.fromEntries(this.journal),
    };
  }
}
export const mediatedEffect = async <T>(
  ledger: EffectLedger,
  request: EffectRequest,
  execute: () => T | Promise<T>,
): Promise<T> => {
  ledger.request(request);
  const outcome = ledger.get(request.id);
  if (outcome?.kind === "fail") throw outcome.value;
  if (outcome?.kind === "hang")
    throw Object.assign(new Error("effect resolution was not supplied within the run budget"), {
      code: "EFFECT_WAIT_BUDGET_EXHAUSTED",
    });
  if (outcome?.kind === "succeed") {
    ledger.recordJournal(request.id);
    return outcome.value as T;
  }
  if (outcome?.kind === "duplicate") {
    const first = await execute();
    ledger.recordJournal(request.id);
    await execute();
    return first;
  }
  const value = await execute();
  ledger.recordJournal(request.id);
  return value;
};
