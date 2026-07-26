import { describe, expect, test } from "bun:test";
import { createMachine, initialTransition, transition } from "xstate";

/**
 * The fold's entire semantics rest on `initialTransition`/`transition`
 * behaving as pure `(machine, ...) => [snapshot, actions]` functions.
 * `initialTransition` landed in xstate 5.19.0 — the bottom of this
 * package's `^5.19.0` peer range — so a peer bump within that range could
 * in principle land on a version where it's missing or reshaped. Fail loud
 * and early instead of a confusing downstream TypeError inside the fold.
 */
describe("xstate API presence (peer range ^5.19.0)", () => {
  test("initialTransition and transition exist and are functions", () => {
    expect(typeof initialTransition).toBe("function");
    expect(typeof transition).toBe("function");
  });

  test("initialTransition and transition both return a [snapshot, actions] tuple", () => {
    // A minimal live check, not just a typeof probe: pins the actual
    // calling contract foldMachine.js relies on.
    const machine = createMachine({ initial: "a", states: { a: { on: { GO: "b" } }, b: {} } });
    const initial = initialTransition(machine, undefined);
    expect(Array.isArray(initial)).toBe(true);
    expect(initial).toHaveLength(2);
    const [snapshot] = initial;
    const next = transition(machine, snapshot, { type: "GO" });
    expect(Array.isArray(next)).toBe(true);
    expect(next).toHaveLength(2);
    expect(next[0].matches("b")).toBe(true);
  });
});
