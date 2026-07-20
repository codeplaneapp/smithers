import { expect } from "bun:test";
import type { RunState } from "@smithers-orchestrator/db/runState/RunState";

// Keep this in lockstep with deriveRunState's RunState return type.
export const ALLOWED_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "paused",
  "recovering",
  "stale",
  "orphaned",
  "failed",
  "cancelled",
  "succeeded",
  "unknown",
]);

export function isIdleLike(state: string): boolean {
  const lowered = state.toLowerCase();
  return lowered === "idle" || lowered === "" || lowered === "unspecified";
}

export function assertNotIdle(state: RunState, scenario: string): void {
  expect(state, `${scenario} produced idle-like state`).not.toBe(
    "idle" as unknown as RunState,
  );
  expect(isIdleLike(state), `${scenario} produced idle-like state`).toBe(false);
  expect(
    ALLOWED_STATES.has(state),
    `${scenario} produced state outside allowed enum: ${state}`,
  ).toBe(true);
}
