/**
 * The closed set of conditions a `<Monitor>` heartbeat may classify a watched
 * run into. Deliberately small: a monitor that can name a hundred states is a
 * monitor nobody can route deterministically. Every sample resolves to exactly
 * one of these, and each one maps to exactly one handler.
 *
 * - `healthy`        — the run is progressing (or has finished cleanly). Do nothing.
 * - `stalled`        — no event for longer than the stall budget, nothing waiting on a human.
 * - `wedged-node`    — one node is burning attempts/retries without changing its error.
 * - `runaway-loop`   — a loop or token burn is growing without approaching its exit condition.
 * - `awaiting-human` — the run is parked on an approval gate or human request.
 * - `failing`        — the run (or a non-continueOnFail node) has failed terminally.
 * - `unknown`        — evidence was unreadable or contradictory. Never guess from here.
 */
export type MonitorCondition =
  | "healthy"
  | "stalled"
  | "wedged-node"
  | "runaway-loop"
  | "awaiting-human"
  | "failing"
  | "unknown";
