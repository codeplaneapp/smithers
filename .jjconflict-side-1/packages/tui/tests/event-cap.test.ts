import { describe, it, expect } from "bun:test";
import { TUI_EVENT_CAP, tuiEventCap } from "../src/data.ts";

/**
 * Historically the gateway cached one `runEvents` collection per run and the
 * FIRST caller's `maxRows` sized its ring (the collection key omitted
 * `maxRows`), so Tree — the initial mode — pinning the ring small dropped later
 * history for Logs/Timeline/Hijack. The collection key now INCLUDES `maxRows`
 * (see gatewayCollectionDefs.runEvents / gatewayKeys), so different caps get
 * separate rings; the shared TUI_EVENT_CAP still matters because it keeps every
 * TUI consumer on ONE collection (and one stream) instead of fragmenting into a
 * per-cap collection per mode.
 *
 * The first-caller-wins fake below models the LEGACY keying to document what
 * the shared cap protected against, and the shared-cap invariants keep the
 * single-collection guarantee pinned today.
 */
const COLLECTION_FLOOR = 1024;

function makeRingCache() {
  const rings = new Map<string, number>();
  /** A TUI consumer subscribing with an optional explicit cap. */
  return (runId: string, maxEvents?: number) => {
    const requested = Math.max(tuiEventCap(maxEvents), COLLECTION_FLOOR);
    if (!rings.has(runId)) rings.set(runId, requested); // first caller wins
    return rings.get(runId)!;
  };
}

describe("TUI run-event cap", () => {
  it("the shared cap is at least the largest window any mode needs (2000)", () => {
    expect(TUI_EVENT_CAP).toBeGreaterThanOrEqual(2000);
  });

  it("tuiEventCap defaults a missing cap to the shared TUI_EVENT_CAP", () => {
    expect(tuiEventCap(undefined)).toBe(TUI_EVENT_CAP);
    expect(tuiEventCap(2000)).toBe(2000);
    // An explicit larger window is honored (would size an even bigger ring).
    expect(tuiEventCap(5000)).toBe(5000);
  });

  it("retains full history when a default/early consumer mounts before a 2000-row consumer", () => {
    const ring = makeRingCache();
    // Tree (the initial mode) mounts FIRST with the default cap...
    const treeRing = ring("run-1");
    // ...then Logs mounts with the explicit 2000 cap.
    const logsRing = ring("run-1", 2000);
    // The first caller fixed the ring size, but because Tree now defaults to the
    // shared cap, that size already holds the full 2000-row window.
    expect(treeRing).toBe(TUI_EVENT_CAP);
    expect(logsRing).toBe(TUI_EVENT_CAP);
    expect(treeRing).toBeGreaterThanOrEqual(2000);
  });

  it("regression: a hard-coded small default would have pinned the ring below 2000", () => {
    // Demonstrate the OLD bug shape with a default that ignores the shared cap.
    const rings = new Map<string, number>();
    const legacyRing = (runId: string, maxEvents = 1000) => {
      const requested = Math.max(maxEvents, COLLECTION_FLOOR);
      if (!rings.has(runId)) rings.set(runId, requested);
      return rings.get(runId)!;
    };
    const tree = legacyRing("run-1"); // default 1000 → floored to 1024
    const logs = legacyRing("run-1", 2000); // wants 2000 but ring already pinned
    expect(tree).toBe(COLLECTION_FLOOR);
    expect(logs).toBe(COLLECTION_FLOOR); // history beyond 1024 lost — the bug
    expect(logs).toBeLessThan(2000);
  });
});
