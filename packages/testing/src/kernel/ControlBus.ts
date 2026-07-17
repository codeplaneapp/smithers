import type { ControlMessage } from "../control/ControlMessage.ts";
export class ControlBus {
  private readonly pending: ControlMessage[];
  private readonly observed: ControlMessage[] = [];
  constructor(input: readonly ControlMessage[] = []) { this.pending = input.map((message) => Object.freeze({ ...message })); }
  /** Append the command at the point it happened. Supplied commands are never
   * searched for or reordered: a generated decision is part of the log even
   * when a later supplied rendezvous is still pending. */
  append(message: ControlMessage): number {
    const next = this.pending[0];
    if (next && JSON.stringify(next) === JSON.stringify(message)) this.pending.shift();
    this.observed.push(Object.freeze({ ...message }));
    return this.observed.length - 1;
  }
  /** Only rendezvoused controls are observations. Pending input is exposed
   * separately so replay cannot mistake unconsumed commands for evidence. */
  log(): readonly ControlMessage[] { return [...this.observed]; }
  find<T extends ControlMessage["type"]>(type: T): Extract<ControlMessage, { readonly type: T }>[] { return [...this.observed, ...this.pending].filter((message) => message.type === type) as Extract<ControlMessage, { readonly type: T }>[]; }
  /** Consume a command at its actual rendezvous and retain it in the replay log. */
  take<T extends ControlMessage["type"]>(type: T): Extract<ControlMessage, { readonly type: T }> | undefined {
    const message = this.pending[0];
    if (message?.type === type) { this.pending.shift(); this.observed.push(message); return message as Extract<ControlMessage, { readonly type: T }>; }
    return undefined;
  }
  /** Advance-clock is consumed only at a virtual-clock rendezvous. */
  takeAdvanceClock(): Extract<ControlMessage, { readonly type: "advance-clock" }> | undefined {
    return this.take("advance-clock");
  }
  /** Consume only the next command. Runtime commands are ordered. */
  takeNext<T extends ControlMessage["type"]>(type: T): Extract<ControlMessage, { readonly type: T }> | undefined {
    const message = this.pending[0];
    if (!message || message.type !== type) return undefined;
    this.pending.shift(); this.observed.push(message);
    return message as Extract<ControlMessage, { readonly type: T }>;
  }
  /**
   * A rendezvous control is ordered, but applicability is part of the
   * rendezvous.  In particular, a pin for a step that is not ready must stay
   * pending until that step becomes ready; consuming it and generating a
   * replacement changes replay identity and can execute the wrong schedule.
   */
  takeApplicablePin(choices: readonly string[]): Extract<ControlMessage, { readonly type: "pin-interleaving" }> | undefined {
    const message = this.pending[0];
    if (message?.type !== "pin-interleaving" || !choices.includes(message.choice)) return undefined;
    this.pending.shift();
    this.observed.push(message);
    return message;
  }
  peek(): ControlMessage | undefined { return this.pending[0]; }
  takeResolve(effect: string): Extract<ControlMessage, { readonly type: "resolve-effect" }> | undefined {
    const message = this.pending[0];
    if (message?.type !== "resolve-effect" || message.effect !== effect) return undefined;
    this.pending.shift(); this.observed.push(message); return message as Extract<ControlMessage, { readonly type: "resolve-effect" }>;
  }
  takeTimerFire(timer: string): Extract<ControlMessage, { readonly type: "timer-fire" }> | undefined {
    const message = this.pending[0];
    if (message?.type !== "timer-fire" || message.timer !== timer) return undefined;
    this.pending.shift(); this.observed.push(message); return message;
  }
  consumed(): number { return this.observed.length; }
  pendingControls(): readonly ControlMessage[] { return [...this.pending]; }
}
