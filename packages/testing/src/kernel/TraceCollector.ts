import type { TraceEvent } from "../trace/TraceEvent.ts";
export class TraceCollector {
  private readonly events: TraceEvent[] = [];
  constructor(private readonly clock: { now(): number }) {}
  emit(event: Omit<TraceEvent, "seq" | "at">): TraceEvent {
    const value = Object.freeze({ ...event, seq: this.events.length, at: this.clock.now() });
    this.events.push(value);
    return value;
  }
  snapshot(): readonly TraceEvent[] {
    return [...this.events];
  }
}
