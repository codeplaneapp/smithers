export class SeededScheduler {
  private state: number;
  private readonly decisions: number[] = [];
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  choose<T>(ready: readonly T[], forcedIndex?: number): T {
    if (!ready.length) throw new Error("SCHEDULER_EMPTY_READY_SET");
    const index = forcedIndex === undefined ? this.next() % ready.length : forcedIndex;
    if (index < 0 || index >= ready.length) throw new RangeError("SCHEDULER_INVALID_INTERLEAVING");
    this.decisions.push(index);
    return ready[index]!;
  }
  snapshot(): readonly number[] {
    return [...this.decisions];
  }
  private next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }
}
