/**
 * The attributed control verbs.
 *
 * Spec 1.4 of `.smithers/specs/flows-migration.md` and §4 of flows'
 * `smithers-replacement-gaps.md`: "a small `RunControl` service that journals
 * an attributed control event (actor, reason) and flips `DurableEngineState`,
 * with hijack shipping as an alternative `RunControl` implementation".
 */

export type RunControlVerb = "pause" | "cancel" | "steer" | "hijack";

/**
 * Who asked, and why. Both are required: an unattributed control verb is the
 * gap this service exists to close, so the type does not let a call site skip
 * them.
 */
export type RunControlAttribution = {
  /** The requester's identity: `cli:pause`, `rpc:gateway`, `user:will`. */
  readonly actor: string;
  /** Free text, journaled verbatim. */
  readonly reason: string;
  /** How the request arrived. */
  readonly transport?: "cli" | "rpc" | "signal" | "engine";
  /** Correlates the journal entry with the caller's request. */
  readonly requestId?: string;
  /** The requesting process, when it has one. */
  readonly clientPid?: number;
};

export type RunControlRequest = RunControlAttribution & {
  readonly verb: RunControlVerb;
  /** `hijack` only: which agent session to hand off to. */
  readonly target?: string | null;
  /** `steer` only: the message to deliver. */
  readonly message?: string;
};

export type RunControlOutcome = {
  readonly runId: string;
  readonly verb: RunControlVerb;
  /** False when the run was already terminal, or another owner won the race. */
  readonly accepted: boolean;
  /** The run status observed after the verb was applied. */
  readonly status: string | null;
  readonly attribution: RunControlAttribution;
  /** The journal sequence the control event landed at, when one was written. */
  readonly seq?: number;
  /** Why an unaccepted verb was refused. */
  readonly refusedBecause?: string;
};
