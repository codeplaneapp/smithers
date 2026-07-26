export type JournalState = "none" | "effect-applied" | "journaled" | "acked";
export type LeaseState = "unclaimed" | "owned" | "lost";
export type WakeupState = "none" | "registered" | "delivered" | "lost";
export class JournalModel {
  private readonly states = new Map<string, JournalState>();
  private readonly leases = new Map<string, LeaseState>();
  private readonly owners = new Map<string, string>();
  private readonly wakeups = new Map<string, WakeupState>();
  state(id: string): JournalState {
    return this.states.get(id) ?? "none";
  }
  effectApplied(id: string): void {
    this.states.set(id, "effect-applied");
  }
  journal(id: string): boolean {
    if (this.state(id) === "journaled" || this.state(id) === "acked") return false;
    this.states.set(id, "journaled");
    return true;
  }
  ack(id: string): void {
    if (this.state(id) !== "journaled")
      throw Object.assign(new Error(`cannot ack unjournaled effect ${id}`), { code: "JOURNAL_ACK_WITHOUT_WRITE" });
    this.states.set(id, "acked");
  }
  claimLease(id: string, owner: string): boolean {
    const current = this.leases.get(id);
    if (current === "owned") return false;
    this.leases.set(id, "owned");
    this.owners.set(id, owner);
    return true;
  }
  assertLease(id: string, owner: string): void {
    if (this.leaseState(id) !== "owned" || this.owners.get(id) !== owner)
      throw Object.assign(new Error(`lease fenced for ${id}`), {
        code: "LEASE_FENCED",
        details: { id, owner, currentOwner: this.owners.get(id) },
      });
  }
  loseLease(id: string): void {
    this.leases.set(id, "lost");
    this.owners.delete(id);
  }
  leaseState(id: string): LeaseState {
    return this.leases.get(id) ?? "unclaimed";
  }
  registerWakeup(id: string): void {
    this.wakeups.set(id, "registered");
  }
  deliverWakeup(id: string): void {
    if (this.wakeups.get(id) === "registered") this.wakeups.set(id, "delivered");
  }
  loseWakeup(id: string): void {
    this.wakeups.set(id, "lost");
  }
  wakeupState(id: string): WakeupState {
    return this.wakeups.get(id) ?? "none";
  }
  snapshot(): Readonly<Record<string, unknown>> {
    return {
      journal: Object.fromEntries(this.states),
      leases: Object.fromEntries(this.leases),
      wakeups: Object.fromEntries(this.wakeups),
    };
  }
}
