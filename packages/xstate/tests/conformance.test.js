import { describe, expect, test } from "bun:test";
import { assign, createMachine, setup } from "xstate";
import {
  computeMachineState,
  foldMachineState,
  orderFoldEvents,
  taskOutput,
  __machineCacheInternals,
} from "../src/index.js";

/**
 * Minimal ctx-shaped fixture: outputRows/signalRows backed by literal rows.
 * The durability suites (e2e.test.jsx) drive the same fold through a real
 * engine + sqlite; these tests pin the pure transition semantics.
 */
function fakeCtx({ runId = `run-${Math.random().toString(36).slice(2)}`, outputs = {}, signals = [] } = {}) {
  return {
    runId,
    outputRows(output, options = {}) {
      const rows = outputs[typeof output === "string" ? output : output?.name] ?? [];
      return rows
        .filter((row) => !options.nodeId || row.nodeId === options.nodeId)
        .filter((row) => !options.scope || row.nodeId.endsWith(options.scope))
        .sort((a, b) => a.seq - b.seq);
    },
    signalRows(signalName, options = {}) {
      return signals
        .filter((row) => row.signalName === signalName)
        .filter((row) => options.correlationId === undefined || row.correlationId === options.correlationId)
        .sort((a, b) => a.seq - b.seq);
    },
  };
}

/** @param {Array<[number, string] | [number, string, Record<string, unknown>]>} entries */
function events(entries) {
  return entries.map(([seq, type, rest], i) => ({ seq, declarationIndex: 0, subIndex: i, event: { type, ...rest } }));
}

describe("fold conformance", () => {
  test("initial assign from input applies without any events", () => {
    const machine = createMachine({
      context: ({ input }) => ({ topic: input.topic, revision: 0 }),
      initial: "researching",
      states: { researching: {} },
    });
    const { snapshot } = foldMachineState(machine, { id: "m", input: { topic: "x" }, events: [] });
    expect(snapshot.context).toEqual({ topic: "x", revision: 0 });
    expect(snapshot.matches("researching")).toBe(true);
    expect(snapshot.can({ type: "NOPE" })).toBe(false);
  });

  test("entry assign at initial transition applies (actions discarded, assign builtin runs)", () => {
    const machine = createMachine({
      context: { n: 0 },
      entry: assign({ n: 41 }),
      initial: "a",
      states: { a: { on: { BUMP: { actions: assign({ n: ({ context }) => context.n + 1 }) } } } },
    });
    const { snapshot } = foldMachineState(machine, {
      id: "m",
      events: events([[1, "BUMP"]]),
    });
    expect(snapshot.context.n).toBe(42);
  });

  test("eventless (always) transitions settle within one fold step", () => {
    const machine = createMachine({
      context: { n: 0 },
      initial: "idle",
      states: {
        idle: { on: { GO: { target: "checking", actions: assign({ n: 5 }) } } },
        checking: { always: [{ guard: ({ context }) => context.n >= 5, target: "high" }, { target: "low" }] },
        high: {},
        low: {},
      },
    });
    const { snapshot } = foldMachineState(machine, { id: "m", events: events([[1, "GO"]]) });
    expect(snapshot.matches("high")).toBe(true);
  });

  test("guards gate transitions deterministically", () => {
    const machine = setup({
      guards: { isEven: ({ event }) => event.value % 2 === 0 },
    }).createMachine({
      initial: "waiting",
      states: {
        waiting: { on: { NUM: { guard: "isEven", target: "even" } } },
        even: {},
      },
    });
    const odd = foldMachineState(machine, { id: "m", events: events([[1, "NUM", { value: 3 }]]) });
    expect(odd.snapshot.matches("waiting")).toBe(true);
    const even = foldMachineState(machine, { id: "m", events: events([[1, "NUM", { value: 4 }]]) });
    expect(even.snapshot.matches("even")).toBe(true);
  });

  test("nested compound state onDone fires when the child reaches its final state", () => {
    const machine = createMachine({
      initial: "phase1",
      states: {
        phase1: {
          initial: "working",
          states: {
            working: { on: { STEP_DONE: "finished" } },
            finished: { type: "final" },
          },
          onDone: "phase2",
        },
        phase2: {},
      },
    });
    const { snapshot } = foldMachineState(machine, { id: "m", events: events([[1, "STEP_DONE"]]) });
    expect(snapshot.matches("phase2")).toBe(true);
  });

  test("machine output function runs at top-level final state", () => {
    const machine = createMachine({
      context: { n: 7 },
      output: ({ context }) => ({ result: context.n }),
      initial: "a",
      states: { a: { on: { END: "done" } }, done: { type: "final" } },
    });
    const { snapshot } = foldMachineState(machine, { id: "m", events: events([[1, "END"]]) });
    expect(snapshot.status).toBe("done");
    expect(snapshot.output).toEqual({ result: 7 });
  });

  test("post-final events are discarded and the snapshot stays stable", () => {
    const machine = createMachine({
      context: { n: 0 },
      initial: "a",
      states: {
        a: { on: { END: "done", BUMP: { actions: assign({ n: ({ context }) => context.n + 1 }) } } },
        done: { type: "final" },
      },
    });
    const { snapshot, folded } = foldMachineState(machine, {
      id: "m",
      events: events([
        [1, "END"],
        [2, "BUMP"],
        [3, "BUMP"],
      ]),
    });
    expect(snapshot.status).toBe("done");
    expect(snapshot.context.n).toBe(0);
    expect(folded).toBe(3);
  });

  test("events not accepted in the current state are discarded without drift across refolds", () => {
    const machine = createMachine({
      context: { accepted: 0 },
      initial: "a",
      states: {
        a: { on: { GO: { target: "b", actions: assign({ accepted: ({ context }) => context.accepted + 1 }) } } },
        b: { on: { BACK: { target: "a", actions: assign({ accepted: ({ context }) => context.accepted + 1 }) } } },
      },
    });
    // GO in state b and BACK in state a are discarded.
    const history = events([
      [1, "GO"],
      [2, "GO"],
      [3, "BACK"],
      [4, "BACK"],
      [5, "GO"],
    ]);
    const first = foldMachineState(machine, { id: "m", events: history });
    const second = foldMachineState(machine, { id: "m", events: history });
    expect(first.snapshot.context.accepted).toBe(3);
    expect(first.snapshot.value).toEqual(second.snapshot.value);
    expect(first.snapshot.context).toEqual(second.snapshot.context);
  });

  test("event ordering is (provenance seq, declaration index, mapped subindex)", () => {
    const machine = createMachine({
      context: { log: [] },
      initial: "a",
      states: {
        a: {
          on: {
            MARK: { actions: assign({ log: ({ context, event }) => [...context.log, event.tag] }) },
          },
        },
      },
    });
    const unordered = [
      { seq: 2, declarationIndex: 1, subIndex: 0, event: { type: "MARK", tag: "s2-d1" } },
      { seq: 1, declarationIndex: 1, subIndex: 1, event: { type: "MARK", tag: "s1-d1-i1" } },
      { seq: 2, declarationIndex: 0, subIndex: 0, event: { type: "MARK", tag: "s2-d0" } },
      { seq: 1, declarationIndex: 0, subIndex: 0, event: { type: "MARK", tag: "s1-d0" } },
      { seq: 1, declarationIndex: 1, subIndex: 0, event: { type: "MARK", tag: "s1-d1-i0" } },
    ];
    const { snapshot } = foldMachineState(machine, { id: "m", events: orderFoldEvents(unordered) });
    expect(snapshot.context.log).toEqual(["s1-d0", "s1-d1-i0", "s1-d1-i1", "s2-d0", "s2-d1"]);
  });

  test("a throwing assigner fails the fold with a typed error naming machine and event", () => {
    const machine = createMachine({
      context: {},
      initial: "a",
      states: {
        a: {
          on: {
            BOOM: {
              actions: assign(() => {
                throw new Error("kaput");
              }),
            },
          },
        },
      },
    });
    expect(() => foldMachineState(machine, { id: "release", events: events([[9, "BOOM"]]) })).toThrow(
      /XSTATE_FOLD_FAILED|release.*BOOM.*seq 9/,
    );
  });

  test("a throwing guard fails the fold with a typed error naming machine and event", () => {
    const machine = createMachine({
      context: {},
      initial: "a",
      states: {
        a: {
          on: {
            CHECK: {
              guard: () => {
                throw new Error("guard kaput");
              },
              target: "b",
            },
          },
        },
        b: {},
      },
    });
    expect(() => foldMachineState(machine, { id: "release", events: events([[9, "CHECK"]]) })).toThrow(
      /XSTATE_FOLD_FAILED|release.*CHECK.*seq 9/,
    );
  });

  test("a throwing context initializer fails the initial transition with a typed error naming the machine", () => {
    const machine = createMachine({
      context: () => {
        throw new Error("context kaput");
      },
      initial: "a",
      states: { a: {} },
    });
    expect(() => foldMachineState(machine, { id: "release", events: [] })).toThrow(
      /XSTATE_FOLD_FAILED|release.*initialTransition/,
    );
  });

  test("spawn inside assign is rejected at fold time (snapshot with children)", () => {
    const machine = createMachine({
      context: {},
      initial: "a",
      states: {
        a: {
          on: {
            SPAWN: {
              actions: assign(({ spawn }) => ({ child: spawn(createMachine({ initial: "x", states: { x: {} } })) })),
            },
          },
        },
      },
    });
    expect(() => foldMachineState(machine, { id: "m", events: events([[1, "SPAWN"]]) })).toThrow(
      /XSTATE_SPAWN_UNSUPPORTED|spawned a child actor/,
    );
  });
});

describe("computeMachineState over ctx", () => {
  const decisionMachine = createMachine({
    context: { revision: 0, feedback: [] },
    initial: "awaiting",
    states: {
      awaiting: {
        on: {
          APPROVED: "shipped",
          REVISE: {
            actions: assign({
              revision: ({ context }) => context.revision + 1,
              feedback: ({ context, event }) => [...context.feedback, event.note],
            }),
          },
        },
      },
      shipped: { type: "final" },
    },
  });

  test("folds output rows and signal rows on the shared seq clock", async () => {
    const { taskOutput, eventReceived } = await import("../src/index.js");
    const ctx = fakeCtx({
      outputs: { gate: [{ payload: { approved: true }, nodeId: "gate", iteration: 0, seq: 4 }] },
      signals: [
        { payload: { feedback: "tighten intro" }, signalName: "REVISE", seq: 2, receivedAtMs: 10 },
        { payload: { feedback: "late note" }, signalName: "REVISE", seq: 9, receivedAtMs: 30 },
      ],
    });
    const state = computeMachineState(ctx, decisionMachine, {
      id: "release",
      events: [
        taskOutput("gate", { nodeId: "gate" }, (d) => (d.approved ? { type: "APPROVED" } : null)),
        eventReceived("REVISE", null, {}, (p) => ({ type: "REVISE", note: p.feedback })),
      ],
    });
    // seq 2 REVISE folds before seq 4 APPROVED; seq 9 REVISE lands post-final and is discarded.
    expect(state.status).toBe("done");
    expect(state.context.revision).toBe(1);
    expect(state.context.feedback).toEqual(["tighten intro"]);
  });

  test("map returning an array orders by subindex; null skips the row", async () => {
    const { taskOutput } = await import("../src/index.js");
    const machine = createMachine({
      context: { log: [] },
      initial: "a",
      states: {
        a: { on: { MARK: { actions: assign({ log: ({ context, event }) => [...context.log, event.tag] }) } } },
      },
    });
    const ctx = fakeCtx({
      outputs: {
        steps: [
          { payload: { tags: ["x", "y"] }, nodeId: "s", iteration: 0, seq: 1 },
          { payload: { tags: null }, nodeId: "s", iteration: 1, seq: 2 },
        ],
      },
    });
    const state = computeMachineState(ctx, machine, {
      id: "marks",
      events: [taskOutput("steps", {}, (p) => (p.tags ? p.tags.map((tag) => ({ type: "MARK", tag })) : null))],
    });
    expect(state.context.log).toEqual(["x", "y"]);
  });

  test("a throwing map callback fails with a typed error naming the source and row", () => {
    const machine = createMachine({ initial: "a", states: { a: { on: { MARK: "b" } }, b: {} } });
    const ctx = fakeCtx({
      outputs: { rows: [{ payload: { tag: "x" }, nodeId: "n1", iteration: 0, seq: 1 }] },
    });
    const source = taskOutput("rows", {}, () => {
      throw new Error("mapper kaput");
    });
    expect(() => computeMachineState(ctx, machine, { id: "release", events: [source] })).toThrow(
      /XSTATE_EVENT_MAP_FAILED|mapper kaput|must be pure/,
    );
  });

  test("eventReceived skips a signal payload that fails schema.safeParse, deterministically across refolds", async () => {
    const { eventReceived } = await import("../src/index.js");
    const schema = {
      safeParse: (value) => (typeof value?.feedback === "string" ? { success: true, data: value } : { success: false }),
    };
    const machine = createMachine({
      context: { feedback: [] },
      initial: "a",
      states: {
        a: {
          on: { REVISE: { actions: assign({ feedback: ({ context, event }) => [...context.feedback, event.note] }) } },
        },
      },
    });
    const ctx = fakeCtx({
      signals: [
        { payload: { feedback: "good note" }, signalName: "REVISE", seq: 1, receivedAtMs: 1 },
        { payload: { malformed: true }, signalName: "REVISE", seq: 2, receivedAtMs: 2 },
        { payload: { feedback: "another good note" }, signalName: "REVISE", seq: 3, receivedAtMs: 3 },
      ],
    });
    const source = eventReceived("REVISE", schema, {}, (p) => ({ type: "REVISE", note: p.feedback }));
    const first = computeMachineState(ctx, machine, { id: "m", events: [source] });
    const second = computeMachineState(ctx, machine, { id: "m", events: [source] });
    expect(first.context.feedback).toEqual(["good note", "another good note"]);
    expect(second.context.feedback).toEqual(["good note", "another good note"]);
  });

  test("eventReceived correlationId scoping folds only signals delivered with a matching correlation id", async () => {
    const { eventReceived } = await import("../src/index.js");
    const machine = createMachine({
      context: { picks: [] },
      initial: "a",
      states: {
        a: { on: { PICK: { actions: assign({ picks: ({ context, event }) => [...context.picks, event.who] }) } } },
      },
    });
    const ctx = fakeCtx({
      signals: [
        { payload: { who: "alice" }, signalName: "PICK", seq: 1, correlationId: "subflow-a", receivedAtMs: 1 },
        { payload: { who: "bob" }, signalName: "PICK", seq: 2, correlationId: "subflow-b", receivedAtMs: 2 },
      ],
    });
    const source = eventReceived("PICK", null, { correlationId: "subflow-a" }, (p) => ({ type: "PICK", who: p.who }));
    const state = computeMachineState(ctx, machine, { id: "m", events: [source] });
    expect(state.context.picks).toEqual(["alice"]);
  });

  test("two machines with distinct ids fold independently in one render ctx", async () => {
    const { eventReceived } = await import("../src/index.js");
    const toggle = createMachine({
      initial: "off",
      states: { off: { on: { FLIP: "on" } }, on: { on: { FLIP: "off" } } },
    });
    const ctx = fakeCtx({ signals: [{ payload: {}, signalName: "FLIP_A", seq: 1, receivedAtMs: 1 }] });
    const a = computeMachineState(ctx, toggle, {
      id: "a",
      events: [eventReceived("FLIP_A", null, {}, () => ({ type: "FLIP" }))],
    });
    const b = computeMachineState(ctx, toggle, {
      id: "b",
      events: [eventReceived("FLIP_B", null, {}, () => ({ type: "FLIP" }))],
    });
    expect(a.matches("on")).toBe(true);
    expect(b.matches("off")).toBe(true);
  });

  test("same id with a different machine in one render ctx is a typed conflict", async () => {
    const m1 = createMachine({ initial: "a", states: { a: {} } });
    const m2 = createMachine({ initial: "b", states: { b: {} } });
    const ctx = fakeCtx({});
    computeMachineState(ctx, m1, { id: "dup" });
    expect(() => computeMachineState(ctx, m2, { id: "dup" })).toThrow(/XSTATE_MACHINE_ID_CONFLICT|distinct id/);
  });

  test("missing or empty id is a typed error", () => {
    const machine = createMachine({ initial: "a", states: { a: {} } });
    expect(() => computeMachineState(fakeCtx({}), machine, { id: "" })).toThrow(/XSTATE_MACHINE_ID_REQUIRED|non-empty/);
    expect(() => computeMachineState(fakeCtx({}), machine, /** @type {any} */ (undefined))).toThrow(
      /XSTATE_MACHINE_ID_REQUIRED|non-empty/,
    );
  });
});
