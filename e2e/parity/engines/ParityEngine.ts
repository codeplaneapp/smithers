import type { ParityFixture } from "../ParityFixture.ts";
import type { ParityEngineId } from "../ParityEngineId.ts";
import type { ParityObservation } from "../ParityObservation.ts";

/** Where one execution of a fixture puts its database and scratch files. */
export type ParityExecuteContext = {
  readonly runId: string;
  readonly dbPath: string;
  readonly scratchDir: string;
};

/**
 * An engine the parity suite can point a fixture at.
 *
 * The suite never imports an engine directly; it goes through this interface,
 * so stage 1.3 adds the flows engine by filling in `flowsEngine` and changes
 * nothing else in the suite.
 */
export type ParityEngine = {
  readonly id: ParityEngineId;
  readonly description: string;
  /**
   * `null` when the engine can run right now, otherwise the reason it cannot.
   * An unavailable engine is skipped rather than failed, and the suite refuses
   * to run at all if no engine is available.
   */
  readonly unavailableReason: () => string | null;
  readonly execute: (
    fixture: ParityFixture,
    context: ParityExecuteContext,
  ) => Promise<ParityObservation>;
};
