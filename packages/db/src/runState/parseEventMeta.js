import { parseWaitForEventAttemptSnapshot } from "../waitForEventAttempt.js";

/**
 * Extract the correlation key a parked `waiting-event` attempt is waiting on.
 *
 * The engine's `buildWaitForEventAttemptMeta` is the only writer of a
 * `waiting-event` attempt's `meta_json`, and it emits
 * `{ kind: "wait-for-event", waitForEvent: { signalName, correlationId, ... } }`,
 * so parsing goes through the shared
 * {@link parseWaitForEventAttemptSnapshot} rather than a second reading of the
 * same on-disk format. Gateway `submitSignal` treats its `correlationKey` as
 * the correlation id (falling back to the signal name when the wait declares
 * no correlation id), so the blocked reason reports exactly the value a caller
 * would have to send to unpark the run.
 *
 * @param {string | null | undefined} metaJson
 * @returns {{ correlationKey: string } | null}
 */
export function parseEventMeta(metaJson) {
  const snapshot = parseWaitForEventAttemptSnapshot(metaJson ?? null);
  if (snapshot == null) return null;
  return { correlationKey: snapshot.correlationId ?? snapshot.signalName };
}
