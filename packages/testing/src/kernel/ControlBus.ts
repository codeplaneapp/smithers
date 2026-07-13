import type { ControlMessage } from "../control/ControlMessage.ts";
export class ControlBus {
  private readonly pending: ControlMessage[];
  private readonly observed: ControlMessage[] = [];
  constructor(input: readonly ControlMessage[] = []) { this.pending = input.map((message) => Object.freeze({ ...message })); }
  /** Record a generated command, consuming its replay counterpart when present. */
  append(message: ControlMessage): number {
    const match = this.pending.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(message));
    if (match >= 0) { const [replayed] = this.pending.splice(match, 1); this.observed.push(replayed!); return this.observed.length - 1; }
    this.observed.push(Object.freeze({ ...message })); return this.observed.length - 1;
  }
  log(): readonly ControlMessage[] { return [...this.observed, ...this.pending]; }
  find<T extends ControlMessage["type"]>(type: T): Extract<ControlMessage, { readonly type: T }>[] { return [...this.observed, ...this.pending].filter((message) => message.type === type) as Extract<ControlMessage, { readonly type: T }>[]; }
  /** Consume a command at its actual rendezvous and retain it in the replay log. */
  take<T extends ControlMessage["type"]>(type: T): Extract<ControlMessage, { readonly type: T }> | undefined {
    const index = this.pending.findIndex((message) => message.type === type);
    if (index >= 0) { const [message] = this.pending.splice(index, 1); this.observed.push(message!); return message as Extract<ControlMessage, { readonly type: T }>; }
    return undefined;
  }
  /** Consume only the next command. Runtime commands are ordered. */
  takeNext<T extends ControlMessage["type"]>(type: T): Extract<ControlMessage, { readonly type: T }> | undefined {
    const message = this.pending[0];
    if (!message || message.type !== type) return undefined;
    this.pending.shift(); this.observed.push(message);
    return message as Extract<ControlMessage, { readonly type: T }>;
  }
  peek(): ControlMessage | undefined { return this.pending[0]; }
  takeResolve(effect: string): Extract<ControlMessage, { readonly type: "resolve-effect" }> | undefined {
    const index = this.pending.findIndex((message) => message.type === "resolve-effect" && message.effect === effect);
    if (index < 0) return undefined;
    const [message] = this.pending.splice(index, 1); this.observed.push(message!); return message as Extract<ControlMessage, { readonly type: "resolve-effect" }>;
  }
  consumed(): number { return this.observed.length; }
}
