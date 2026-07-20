export type DurabilityPhase = "before-task" | "during-task" | "after-task" | "after-effect-before-journal" | "after-journal-before-ack" | "after-ack";
export type DurabilityOperation = "task" | "effect" | "attempt-write" | "event-append" | "completion-cas" | "heartbeat" | "lease" | "resume" | "cancellation";
export type DurabilityCutPoint = Readonly<{ readonly phase: DurabilityPhase; readonly operation: DurabilityOperation }>;
export const cutPoint = (phase: DurabilityPhase, operation: DurabilityOperation): DurabilityCutPoint => Object.freeze({ phase, operation });
