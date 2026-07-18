import { describe, expect, test } from "bun:test";
import { barrier, compareBoundaryShape, e2eDescriptor, e2eHarness, fault, mediatedEffect, EffectLedger, runScenario, scenario, step, VirtualClock, firstDivergence, makeReplayBundle, serializeReplayBundle, loadReplayBundle, replayBundle, CleanupScope, assertNoLeaks, contractProbe, unitSimHarness, integrationHarness, realDbAdapter, realProcessAdapter, expectEffect, shrink } from "../src/index.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("controlled scenario kernel", () => {
  test("admits scenario-declared capabilities and refuses fake real harnesses", async () => {
    const ast = scenario("real", { steps: [step("task", { capabilities: ["real-db"] })] });
    const result = await runScenario(ast, { harness: e2eDescriptor(), seed: 4 });
    expect(result.status).toBe("capability-failure");
    expect(result.capabilityReport.some((entry) => entry.kind === "capability-failure")).toBe(true);
  });

  test("executes dependencies, barriers, and typed faults in the unit harness", async () => {
    const ast = scenario("controlled", { steps: [step("a"), step("b", { dependsOn: ["a"] })], barriers: [barrier("ready", ["a", "b"], 2)], faults: [fault("crash", "before-task", "task")] });
    const result = await runScenario(ast, { seed: 1 });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
  });

  test("reports the first task failure while a sibling remains blocked", async () => {
    const result = await runScenario(scenario("failure-first", { steps: [
      step("boom", { runnerBinding: "test:failure-first:boom:v1", run: () => { throw Object.assign(new Error("boom"), { code: "BOOM" }); } }),
      step("blocked", { runnerBinding: "test:failure-first:blocked:v1", run: async (runtime) => { await runtime.sleep(1_000_000); return "late"; } }),
    ] }), { waitBudget: 100 });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("BOOM");
    expect(result.error?.code).not.toBe("CLEANUP_LEAK");
  });

  test("schedules newly-ready transitions before an unrelated sleeping sibling", async () => {
    const started: string[] = [];
    const result = await runScenario(scenario("event-driven", { steps: [
      step("a", { runnerBinding: "test:event-driven:a:v1", run: () => { started.push("a"); return "a"; } }),
      step("b", { runnerBinding: "test:event-driven:b:v1", run: async (runtime) => { started.push("b"); await runtime.sleep(20); return "b"; } }),
      step("c", { dependsOn: ["a"], runnerBinding: "test:event-driven:c:v1", run: () => { started.push("c"); return "c"; } }),
    ] }), { controlLog: [{ type: "pin-interleaving", choice: "a" }, { type: "pin-interleaving", choice: "c" }] });
    expect(result.status).toBe("finished");
    const cStarted = result.trace.findIndex((event) => event.type === "task" && (event.data as { state?: string; step?: string }).state === "started" && (event.data as { step?: string }).step === "c");
    const bFinished = result.trace.findIndex((event) => event.type === "task" && (event.data as { state?: string; step?: string }).state === "finished" && (event.data as { step?: string }).step === "b");
    expect(cStarted).toBeGreaterThan(-1);
    expect(bFinished).toBeGreaterThan(-1);
    expect(cStarted).toBeLessThan(bFinished);
    expect(result.controlLog.filter((control) => control.type === "pin-interleaving")).toEqual([
      { type: "pin-interleaving", choice: "a" },
      { type: "pin-interleaving", choice: "b" },
      { type: "pin-interleaving", choice: "c" },
    ]);
  });

  test("does not manufacture lease loss for a no-op task", async () => {
    const result = await runScenario(scenario("lease-noop", { steps: [step("noop")], faults: [fault("lease", "during-task", "lease")] }));
    expect(result.ambiguity).toEqual([]);
  });

  test("does not classify a synchronous callback as a cancellation race", async () => {
    const result = await runScenario(scenario("completed-before-cancel", {
      steps: [step("work", { runnerBinding: "test:completed-before-cancel:work:v1", run: () => "done" })],
      faults: [fault("cancel", "during-task", "cancellation")],
    }));
    expect(result.status).toBe("finished");
    expect(result.outputs.work).toBe("done");
    expect(result.ambiguity).toEqual([]);
  });

  test("does not manufacture duplicate delivery from an unused pending control", async () => {
    const result = await runScenario(scenario("unused-duplicate", { steps: [step("noop")] }), {
      controlLog: [{ type: "resolve-effect", effect: "noop:write", outcome: "duplicate" }],
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CONTROL_UNCONSUMED");
    expect(result.ambiguity).toEqual([]);
  });

  test("operation cut points are fail-closed when the operation did not occur", async () => {
    for (const operation of ["completion-cas", "event-append", "effect"] as const) {
      const phase = operation === "effect" ? "after-effect-before-journal" as const : operation === "completion-cas" ? "after-task" as const : "during-task" as const;
      const result = await runScenario(scenario(`no-op-${operation}`, { steps: [step("noop")], faults: [fault("wrong", phase, operation)] }));
      expect(result.status, operation).toBe("finished");
      expect(result.ambiguity, operation).toEqual([]);
    }
  });

  test("advance-clock is an ordered observation and is replayable", async () => {
    const ast = scenario("explicit-clock", { steps: [step("wait", { runnerBinding: "test:explicit-clock:wait:v1", run: (runtime) => runtime.sleep(5) })] });
    const first = await runScenario(ast, { controlLog: [{ type: "advance-clock", ms: 5 }] });
    const replay = await runScenario(ast, { controlLog: first.controlLog });
    expect(first.status).toBe("finished");
    expect(first.controlLog[0]).toEqual({ type: "advance-clock", ms: 5 });
    expect(replay.controlLog).toEqual(first.controlLog);
    expect(replay.trace).toEqual(first.trace);
  });

  test("shrinking skips unchanged dependency candidates", async () => {
    const ast = scenario("shrink", { steps: [step("root"), step("leaf", { dependsOn: ["root"] }), step("extra")] });
    const seen: string[] = [];
    const result = await shrink(ast, [], async (candidate) => { seen.push(candidate.steps.map((item) => item.id).join(",")); return candidate.steps.length === 2 && candidate.steps.some((item) => item.id === "root"); }, { maxCandidates: 10 });
    expect(result.ast.steps.length).toBe(2);
    expect(result.candidatesTried).toBeLessThan(10);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("counts duplicate mediated delivery honestly", async () => {
    const ledger = new EffectLedger();
    ledger.resolve("effect-1", { kind: "duplicate" });
    let calls = 0;
    await mediatedEffect(ledger, { id: "effect-1", name: "write" }, () => ++calls);
    expect(calls).toBe(2);
  });

  test("bounds recursive zero-time callbacks", () => {
    const clock = new VirtualClock();
    let calls = 0;
    const loop = () => { calls++; clock.sleep(0, loop); };
    clock.sleep(0, loop);
    expect(() => clock.runUntilIdle(3)).toThrow("VIRTUAL_TIME_BUDGET_EXHAUSTED");
    expect(calls).toBe(3);
  });

  test("compares recursive native boundary shape and serialization", () => {
    const expected = compareBoundaryShape(
      { name: "Native", className: "Native", code: "E", hasCause: true, cause: { name: "Cause", className: "Cause", hasCause: false, detailsKeys: [] }, details: { key: 1 }, detailsKeys: ["key"], serialized: { code: "E" } },
      { name: "Native", className: "Native", code: "E", hasCause: true, cause: { name: "Cause", className: "Cause", hasCause: false, detailsKeys: [] }, details: { other: 1 }, detailsKeys: ["other"], serialized: { code: "DIFFERENT" } },
    );
    expect(expected).toEqual(["details differs", "detailsKeys differs", "serialized differs"]);
  });

  test("executes async virtual time and records opaque effects", async () => {
    const result = await runScenario(scenario("timer", { steps: [step("wait", { runnerBinding: "test:timer:wait:v1", run: async (runtime) => { await runtime.sleep(5); await runtime.opaque("file-write", () => "done"); return "ok"; } })] }));
    expect(result.status).toBe("finished");
    expect(result.outputs.wait).toBe("ok");
    expect(result.trace.some((event) => event.type === "opaque-effect" && (event.data as { name?: unknown } | undefined)?.name === "file-write")).toBe(true);
  });

  test("wires effect cut points to ambiguity output", async () => {
    const result = await runScenario(scenario("crash-window", { steps: [step("write", { runnerBinding: "test:crash-window:write:v1", run: async (runtime) => runtime.effect("write", () => "committed") })], faults: [fault("crash", "after-effect-before-journal", "effect")] }));
    expect(result.status).toBe("failed");
    expect(result.ambiguity[0]?.outcome).toBe("effect-applied-journal-missing");
  });

  test("replay bundles and divergence identify changed fields", () => {
    const ast = scenario("replay", { steps: [step("a")] });
    const bundle = loadReplayBundle(serializeReplayBundle(makeReplayBundle({ ast, seed: 3, controlLog: [{ type: "pin-interleaving", choice: "a" }] })));
    expect(bundle.replayIdentity).toBe(makeReplayBundle({ ast, seed: 3, controlLog: [{ type: "pin-interleaving", choice: "a" }] }).replayIdentity);
    expect(firstDivergence([{ seq: 0, at: 0, type: "task", data: { state: "started" } }], [{ seq: 0, at: 0, type: "task", data: { state: "finished" } }])?.field).toBe("data");
  });

  test("rejects a replay bundle whose controls no longer match its identity", async () => {
    const ast = scenario("tampered-replay", { steps: [step("a")] });
    const bundle = makeReplayBundle({ ast, seed: 3, controlLog: [] });
    const tampered = { ...bundle, controlLog: [{ type: "pin-interleaving" as const, choice: "a" }] };
    await expect(replayBundle(tampered)).rejects.toThrow("REPLAY_IDENTITY_MISMATCH");
  });

  test("cleanup bounds a hanging disposer and preserves explicit capability skips", async () => {
    const scope = new CleanupScope(); scope.register("child", "hung", () => new Promise<void>(() => undefined));
    await expect(scope.close(1, 1)).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
    const skipped = await runScenario(scenario("requires-db", { steps: [step("db", { capabilities: ["real-db"] })] }), { harness: unitSimHarness({ policy: "skip" }) });
    expect(skipped.status).toBe("capability-skip");
    expect(() => expectEffect("write").exactlyOnce()).toThrow("Exactly-once external effects are unsupported");
  });

  test("cleanup releases older resources after a failed disposer and reports the failed resource", async () => {
    const scope = new CleanupScope();
    let olderReleased = false;
    scope.register("db", "older", () => { olderReleased = true; });
    scope.register("child", "fails", () => { throw new Error("still-live"); });
    await expect(scope.close(3, 100)).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
    expect(olderReleased).toBe(true);
    expect(() => assertNoLeaks(scope)).toThrow("child/fails");
  });

  test("contract probes compare native serialization", async () => {
    const report = await contractProbe("serialized-error", () => { throw Object.assign(new Error("bad"), { code: "E_BAD", tag: "native" }); }, () => { throw Object.assign(new Error("bad"), { code: "E_BAD", tag: "native" }); }, { serializeProduction: (value) => ({ code: (value as { code?: string }).code }), serializeSimulation: (value) => ({ code: (value as { code?: string }).code }) });
    expect(report.passed).toBe(true);
  });

  test("ordered controls are consumed at their execution points and replay is runnable", async () => {
    const ast = scenario("ordered", { steps: [step("wait", { runnerBinding: "test:ordered:wait:v1", run: async (runtime) => { await runtime.sleep(2); return "done"; } })] });
    const first = await runScenario(ast, { seed: 7 });
    const bundle = makeReplayBundle({ ast, seed: 7, controlLog: first.controlLog, trace: first.trace });
    const replay = await replayBundle(bundle);
    expect(replay.status).toBe("finished");
    expect(replay.replayIdentity).toBe(bundle.replayIdentity);
  });

  test("mixed rendezvous controls replay byte-for-byte without growing the log", async () => {
    const ast = scenario("mixed-controls", { steps: [step("a", { runnerBinding: "test:mixed-controls:a:v1", run: async (runtime) => { await runtime.effect("write", () => "ok"); return "a"; } }), step("b", { runnerBinding: "test:mixed-controls:b:v1", run: () => "b" })] });
    const controls = [{ type: "resolve-effect" as const, effect: "a:write", outcome: "succeed" as const }, { type: "pin-interleaving" as const, choice: "b" }];
    const first = await runScenario(ast, { seed: 9, controlLog: controls });
    const replay = await runScenario(ast, { seed: 9, controlLog: first.controlLog });
    expect(replay.controlLog).toEqual(first.controlLog);
    // The first run rejects the out-of-order supplied controls; replaying its
    // observed log is a different successful input and must not collide with
    // the failure identity.
    expect(replay.replayIdentity).not.toBe(first.replayIdentity);
    expect(first.status).toBe("failed");
    expect(replay.status).toBe("finished");
    expect(replay.trace).toEqual(first.trace);
  });

  test("restart-in-task performs a resumed attempt", async () => {
    let attempts = 0;
    const result = await runScenario(scenario("restart", { steps: [step("work", { runnerBinding: "test:restart:v1", run: async () => { attempts++; if (attempts === 1) await new Promise((resolve) => setTimeout(resolve, 10)); return attempts; } })], faults: [fault("restart", "during-task", "resume")] }));
    expect(result.status).toBe("finished");
    expect(attempts).toBe(2);
    expect(result.ambiguity.some((item) => item.outcome === "restart-in-task")).toBe(true);
  });

  test("each required ambiguity is emitted from a wired transition", async () => {
    const cases = [
      ["duplicate-delivery", scenario("duplicate", { steps: [step("write", { runnerBinding: "test:ambiguity:duplicate:v1", run: (runtime) => runtime.effect("write", () => "ok") })] }) , [{ type: "resolve-effect" as const, effect: "write:write", outcome: "duplicate" as const }]],
      ["effect-applied-journal-missing", scenario("effect-crash", { steps: [step("write", { runnerBinding: "test:ambiguity:effect-crash:v1", run: (runtime) => runtime.effect("write", () => "ok") })], faults: [fault("f", "after-effect-before-journal", "effect")] }), []],
      ["journal-applied-ack-missing", scenario("ack-crash", { steps: [step("write", { runnerBinding: "test:ambiguity:ack-crash:v1", run: (runtime) => runtime.effect("write", () => "ok") })], faults: [fault("f", "after-journal-before-ack", "effect")] }), []],
      ["lost-wakeup", scenario("wakeup", { steps: [step("wait", { runnerBinding: "test:ambiguity:wakeup:v1", run: (runtime) => runtime.sleep(1) })], faults: [fault("f", "during-task", "event-append")] }), []],
      ["cancellation-race", scenario("cancel", { steps: [step("work", { runnerBinding: "test:ambiguity:cancel:v1", run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return "ok"; } })], faults: [fault("f", "during-task", "cancellation")] }), []],
      ["lease-lost", scenario("lease", { steps: [step("work", { runnerBinding: "test:ambiguity:lease:v1", run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return "ok"; } })], faults: [fault("f", "during-task", "lease")] }), []],
      ["restart-in-task", scenario("restart", { steps: [step("work", { runnerBinding: "test:ambiguity:restart:v1", run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return "ok"; } })], faults: [fault("f", "during-task", "resume")] }), []],
    ] as const;
    for (const [outcome, ast, controlLog] of cases) {
      const result = await runScenario(ast, { controlLog });
      expect(result.ambiguity.some((item) => item.outcome === outcome), outcome).toBe(true);
    }
  });

  test("a real adapter must execute its verified production operation", async () => {
    let admitted = 0;
    let executed = 0;
    const harness = integrationHarness({ adapter: realDbAdapter({
      open: async () => ({ path: "/tmp/smithers-testing-framework-real.db", productionIdentity: "SmithersDb" as const, insertRun: async () => { admitted += 1; }, heartbeatRun: async () => undefined, operations: { observed: () => { executed += 1; return "real"; } }, close: () => undefined }),
    }) });
    const result = await runScenario(scenario("adapter", { steps: [step("observed", { runnerBinding: "test:adapter:observed:v1", run: () => "simulated" })] }), { harness });
    expect(result.status).toBe("capability-failure");
    expect(admitted).toBe(0);
    expect(executed).toBe(0);
  });

  test("barriers require an ordered release and unknown injected faults fail", async () => {
    const ast = scenario("barrier-control", { steps: [step("a")], barriers: [barrier("gate", ["a"], 1)] });
    const blocked = await runScenario(ast);
    expect(blocked.status).toBe("failed");
    expect(blocked.error?.code).toBe("BARRIER_TIMEOUT");
    const released = await runScenario(ast, { controlLog: [{ type: "release-barrier", barrier: "gate" }] });
    expect(released.status).toBe("finished");
    const invalid = await runScenario(ast, { controlLog: [{ type: "inject-fault", fault: "missing" }] });
    expect(invalid.error?.code).toBe("CONTROL_INVALID");
  });

  test("anonymous executable identities are retired — every run callback requires an explicit binding", () => {
    // Sol's round-8 counterexample: the content-addressed anonymous identity
    // was only as trustworthy as the mutable pre-import `Function`
    // constructor that recompiled it. Even a provably-stateless callback is
    // now rejected with RUNNER_BINDING_REQUIRED instead of minting an
    // identity, and the same callback with a caller-owned binding runs.
    const runner = () => "same";
    expect(() => step("task", { run: runner })).toThrow("RUNNER_BINDING_REQUIRED");
    const bound = step("task", { runnerBinding: "test:retired-anonymous:task:v1", run: runner });
    expect(bound.runnerBinding).toBe("test:retired-anonymous:task:v1");
  });

  test("rejects source-identical captured closures without an explicit executable binding", () => {
    const make = (value: number) => () => ({ value });
    expect(() => step("captured", { run: make(1) })).toThrow("RUNNER_BINDING_AMBIGUOUS");
  });

  test("rejects regex-literal closures that launder declaration keywords through regex text", () => {
    const make = (value: string) => () => [/var value/, value] as const;
    // Byte-identical source with genuinely divergent behavior — the collision
    // Sol reproduced across fresh processes when this form was admitted: the
    // unlexed regex text `var value` credited the capture as a local.
    expect(Function.prototype.toString.call(make("A"))).toBe(Function.prototype.toString.call(make("B")));
    expect(make("A")()[1]).toBe("A");
    expect(make("B")()[1]).toBe("B");
    expect(() => step("regex-capture", { run: make("A") })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    // Division shares the `/` token with regex openers; the anonymous grammar
    // excludes both so a slash can never smuggle unparsed source text. (The
    // operands must not be constant-foldable or the transpiler erases the `/`.)
    expect(() => step("division", { run: (_runtime, input) => (input as number) / 2 })).toThrow("RUNNER_BINDING_AMBIGUOUS");
  });

  test("implicit-coercion closures fail closed: byte-identical source diverges under mutated intrinsics", () => {
    // Sol's round-4 counterexample: `() => [] + []` is capture-free, but `+`
    // applies ToPrimitive to the arrays, which walks the MUTABLE
    // `Array.prototype.toString` — two fresh processes with different
    // prototype state produced outputs "AA" versus "BB" from one anonymous
    // identity. Sanity first: the divergence is real.
    const coercion = () => ([] as unknown as string) + ([] as unknown as string);
    const original = Array.prototype.toString;
    try {
      (Array.prototype as unknown as { toString: () => string }).toString = function () { return "A"; };
      expect(coercion()).toBe("AA");
      (Array.prototype as unknown as { toString: () => string }).toString = function () { return "B"; };
      expect(coercion()).toBe("BB");
    } finally {
      Array.prototype.toString = original;
    }
    expect(() => step("coercion", { run: coercion })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    // Allocation, comparison, loose equality, and async forms are equally
    // outside the grammar: each reaches a mutable intrinsic protocol
    // (`toJSON`/`toString`/`valueOf` on allocated objects, ToPrimitive on
    // unprovable operand types, thenable adoption on async settlement).
    expect(() => step("array-alloc", { run: () => [0] })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    expect(() => step("object-alloc", { run: () => ({ fixedKey: 0 }) })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    expect(() => step("comparison", { run: (_runtime, input) => (input as number) < 2 })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    expect(() => step("loose-eq", { run: (_runtime, input) => (input as unknown) == null })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    expect(() => step("async-arrow", { run: async () => "same" })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    expect(() => step("await-form", { run: async (_runtime, input) => await input })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    // Sol's round-6 counterexample: loose INEQUALITY slipped past the scanner
    // when the `!` was consumed as boolean-not and the trailing `=` as plain
    // assignment. Sanity first: the boolean result genuinely diverges under a
    // mutated `Object.prototype[Symbol.toPrimitive]`, so admission would
    // corrupt replay identity while the primitive-result guard stays blind.
    const looseNe = (_runtime: unknown, input: unknown) => (input as string) != "A";
    const objectProto = Object.prototype as unknown as Record<symbol, unknown>;
    try {
      objectProto[Symbol.toPrimitive] = function () { return "A"; };
      expect(looseNe(undefined, { boxed: true })).toBe(false);
      objectProto[Symbol.toPrimitive] = function () { return "B"; };
      expect(looseNe(undefined, { boxed: true })).toBe(true);
    } finally {
      delete objectProto[Symbol.toPrimitive];
    }
    expect(() => step("loose-ne", { run: looseNe })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    // The coercion-free subset is provably stateless, but anonymous
    // identities are retired outright (the compilation primitive that made
    // "digest == behavior" true was mutable pre-import realm state), so even
    // these forms fail closed with the retirement code rather than the
    // ambiguity code.
    expect(() => step("still-admitted", { run: (_runtime, input) => input === "x" ? "eq" : "ne" })).toThrow("RUNNER_BINDING_REQUIRED");
    expect(() => step("strict-ne-admitted", { run: (_runtime, input) => input !== "x" })).toThrow("RUNNER_BINDING_REQUIRED");
  });

  test("a post-import forged Function.prototype.toString cannot mint anonymous identity", () => {
    // Sol's round-7 counterexample: the reflection primitive establishing
    // source identity is ITSELF a mutable intrinsic. Forged post-import to
    // report the same stateless-looking source for two DIFFERENT ordinary
    // closures, admission previously issued one anonymous binding and one
    // replay identity for divergent behavior. Sanity first: the forgery is
    // live for direct property lookups.
    const make = (value: string) => function () { return value; };
    const original = Function.prototype.toString;
    try {
      (Function.prototype as unknown as { toString: unknown }).toString = function toString() { return `(_runtime, input) => "same"`; };
      expect(Function.prototype.toString.call(make("A"))).toBe(`(_runtime, input) => "same"`);
      // The builder reads source through the intrinsic captured at module
      // initialization, so admission sees the REAL capturing source and both
      // closures fail closed instead of colliding.
      expect(() => step("forged-tostring-a", { run: make("A") })).toThrow("RUNNER_BINDING_AMBIGUOUS");
      expect(() => step("forged-tostring-b", { run: make("B") })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    } finally {
      Function.prototype.toString = original;
    }
    // With the forgery removed, provably-stateless source is still refused an
    // anonymous identity — the retirement is unconditional — but with the
    // retirement code rather than the ambiguity code.
    expect(() => step("forged-tostring-restored", { run: () => "same" })).toThrow("RUNNER_BINDING_REQUIRED");
  });

  test("the anonymous: binding namespace cannot be forged by callers", () => {
    // A caller-supplied `anonymous:` binding would collide with framework-
    // issued content-addressed identities while naming a different executable.
    const make = (value: string) => function () { return value; };
    expect(() => step("forged", { runnerBinding: "anonymous:forged", run: make("A") })).toThrow("RUNNER_BINDING_CONFLICT");
    expect(() => step("forged-runnerless", { runnerBinding: "anonymous:deadbeef" })).toThrow("RUNNER_BINDING_CONFLICT");
  });

  test("empty and invalid runnerBindings are rejected at authoring and at admission", async () => {
    // Sol's round-9 counterexample: `runnerBinding: ""` counted as explicit
    // (skipping RUNNER_BINDING_REQUIRED) while truthiness spreads dropped it
    // from the canonical AST and the registry kept the executable — an
    // anonymous executable identity in all but name. Validity is a runtime
    // predicate: empty, whitespace-only, and non-string bindings are refused
    // whether or not a callback is attached, and a hand-crafted AST carrying
    // one is refused at admission with or without an out-of-band runner.
    const make = (value: string) => function () { return value; };
    expect(() => step("empty", { runnerBinding: "", run: make("A") })).toThrow("RUNNER_BINDING_INVALID");
    expect(() => step("empty-inert", { runnerBinding: "" })).toThrow("RUNNER_BINDING_INVALID");
    expect(() => step("whitespace", { runnerBinding: "   ", run: make("A") })).toThrow("RUNNER_BINDING_INVALID");
    expect(() => step("nonstring", { runnerBinding: 7 as unknown as string, run: make("A") })).toThrow("RUNNER_BINDING_INVALID");
    const emptyAst = { version: 1 as const, name: "handcrafted-empty", steps: [{ kind: "step" as const, id: "pass", dependsOn: [], capabilities: [], runnerBinding: "" }], barriers: [], faults: [], extensions: [] };
    let executed = 0;
    const withRunner = await runScenario(emptyAst, { stepRunners: { pass: () => { executed++; return "forged"; } } });
    expect(withRunner.status).toBe("failed");
    expect(withRunner.error?.code).toBe("RUNNER_BINDING_REQUIRED");
    expect(withRunner.outputs).toEqual({});
    expect(executed).toBe(0);
    const inert = await runScenario(emptyAst);
    expect(inert.status).toBe("failed");
    expect(inert.error?.code).toBe("RUNNER_BINDING_INVALID");
    const nonStringAst = { version: 1 as const, name: "handcrafted-nonstring", steps: [{ kind: "step" as const, id: "pass", dependsOn: [], capabilities: [], runnerBinding: 7 as unknown as string }], barriers: [], faults: [], extensions: [] };
    const nonString = await runScenario(nonStringAst);
    expect(nonString.status).toBe("failed");
    expect(nonString.error?.code).toBe("RUNNER_BINDING_INVALID");
  });

  test("object passthrough cannot run unbound and hand-crafted anonymous ASTs cannot execute", async () => {
    // The unbound passthrough was previously admitted anonymously and stopped
    // only by the kernel's primitive-result guard; with anonymous identities
    // retired it is rejected at authoring, before any thenable adoption or
    // serialization channel exists. The same runner with an explicit
    // caller-owned binding carries the caller's identity and runs. An AST is
    // plain data, so a hand-crafted step claiming a retired `anonymous:`
    // binding (paired with an out-of-band runner) must be refused at
    // admission rather than reviving the namespace.
    expect(() => step("pass", { input: { boxed: true }, run: (_runtime, input) => input })).toThrow("RUNNER_BINDING_REQUIRED");
    const bound = await runScenario(scenario("guard-bound", { steps: [step("pass", { runnerBinding: "test:guard:pass:v1", input: { boxed: true }, run: (_runtime, input) => input })] }));
    expect(bound.status).toBe("finished");
    expect(bound.outputs.pass).toEqual({ boxed: true });
    const forgedAst = { version: 1 as const, name: "forged-anonymous", steps: [{ kind: "step" as const, id: "pass", dependsOn: [], capabilities: [], runnerBinding: "anonymous:2f7c15c8" }], barriers: [], faults: [], extensions: [] };
    const revived = await runScenario(forgedAst, { stepRunners: { pass: () => "forged" } });
    expect(revived.status).toBe("failed");
    expect(revived.error?.code).toBe("RUNNER_BINDING_CONFLICT");
    expect(revived.outputs).toEqual({});
  });

  test("caller-forged real-process identity is rejected before spawn", async () => {
    let spawned = false;
    let probed = false;
    const adapter = realProcessAdapter({ runnerPath: "/tmp/impostor-engineChildRunner.ts", probe: async () => { probed = true; throw new Error("must not probe"); }, spawn: async () => { spawned = true; throw new Error("must not spawn"); } });
    const result = await runScenario(scenario("forged-process", { steps: [step("work")] }), { harness: e2eHarness({ adapter }) });
    expect(result.status).toBe("capability-failure");
    expect(result.error?.code).toBe("ADMISSION_FAILED");
    expect(spawned).toBe(false);
    expect(probed).toBe(false);
  });

  test("an impostor admission probe is rejected even with the probe marker, the right nonce, and a clean exit", async () => {
    // The runner path IS the repository-owned production runner, so identity
    // resolution succeeds and admission reaches the probe child — which is an
    // impostor shell that prints the correct probe marker for the adapter's
    // nonce and exits 0, but is not the production runner executable.
    const runner = fileURLToPath(new URL("../../../e2e/harness/engineChildRunner.ts", import.meta.url));
    let spawned = false;
    const impostors: ReturnType<typeof spawn>[] = [];
    const adapter = realProcessAdapter({ runnerPath: runner, probe: async (nonce: string) => {
      const child = spawn("sh", ["-c", `printf 'SMITHERS_ENGINE_HANDSHAKE=probe:%s\\n' "$0"`, nonce], { stdio: ["ignore", "pipe", "ignore"] });
      impostors.push(child);
      return { pid: child.pid!, child, handshake: async () => nonce, kill: (signal?: string) => { child.kill(signal as NodeJS.Signals | undefined); }, close: () => undefined };
    }, spawn: async () => { spawned = true; throw new Error("must not spawn"); } });
    const result = await runScenario(scenario("impostor-probe", { steps: [step("work")] }), { harness: e2eHarness({ adapter }) });
    expect(result.status).toBe("capability-failure");
    expect(result.error?.code).toBe("ADMISSION_FAILED");
    expect(spawned).toBe(false);
    for (const child of impostors) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  test("restarted attempts retain distinct live resources", async () => {
    let attempt = 0;
    const result = await runScenario(scenario("restart-leak", { steps: [step("work", { runnerBinding: "test:restart-leak:v1", run: async () => { attempt++; if (attempt === 1) await new Promise<void>(() => undefined); return "done"; } })], faults: [fault("restart", "during-task", "resume")] }), { cleanupBudget: 1, waitBudget: 100 });
    expect(result.error?.code).toBe("CLEANUP_LEAK");
    expect(result.error?.message).toContain("task-fiber/work");
  });

  test("rejects two different closures that reuse an explicit replay binding", () => {
    step("first", { runnerBinding: "module:worker:v1", run: () => "A" });
    expect(() => step("second", { runnerBinding: "module:worker:v1", run: () => "B" })).toThrow("RUNNER_BINDING_CONFLICT");
  });

  test("journaled-at-most-once requires a journal-write observation", () => {
    const fakeResult = { trace: [{ type: "effect", data: { name: "write", state: "resolved" } }], ambiguity: [{ outcome: "duplicate-delivery" }] };
    expect(() => expectEffect("write").atMostOnceJournaled(fakeResult)).not.toThrow();
  });

  test("tracks an interrupted callback until its promise settles", async () => {
    let released = false;
    const result = await runScenario(scenario("tracked-fiber", { steps: [step("work", { runnerBinding: "module:tracked:v1", run: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 50)); released = true; return "late"; } })], faults: [fault("interrupt", "during-task", "cancellation")] }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    expect(released).toBe(true);
  });

  test("reports an unresolved mediated effect as a cleanup leak", async () => {
    const result = await runScenario(scenario("tracked-effect", { steps: [step("work", { runnerBinding: "module:tracked-effect:v1", run: (runtime) => runtime.effect("hang", () => new Promise(() => undefined)) })] }), { controlLog: [{ type: "resolve-effect", effect: "work:hang", outcome: "hang" }], cleanupBudget: 1 });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CLEANUP_LEAK");
    expect(result.error?.message).toContain("mediated-effect/work:hang");
  });

  test("controlled effect values are authoritative and do not invoke the caller operation", async () => {
    let calls = 0;
    const result = await runScenario(scenario("controlled-value", { steps: [step("write", { runnerBinding: "test:controlled-value:write:v1", run: (runtime) => runtime.effect("write", () => { calls++; return "real"; }) })] }), { controlLog: [{ type: "resolve-effect", effect: "write:write", outcome: "succeed", value: "controlled" }] });
    expect(result.status).toBe("finished");
    expect(result.outputs.write).toBe("controlled");
    expect(calls).toBe(0);
  });

  test("leftover controls fail instead of becoming replay observations", async () => {
    const result = await runScenario(scenario("leftover-control", { steps: [step("a")] }), { controlLog: [{ type: "pin-interleaving", choice: "a" }, { type: "advance-clock", ms: 99 }] });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CONTROL_UNCONSUMED");
  });

  test("timer controls rendezvous with the exact timer identity", async () => {
    const result = await runScenario(scenario("wrong-timer", { steps: [step("wait", { runnerBinding: "test:wrong-timer:wait:v1", run: (runtime) => runtime.sleep(2) })] }), { controlLog: [{ type: "timer-fire", timer: "999" }] });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CONTROL_OUT_OF_ORDER");
  });

  test("idempotency assertions require the requested key and scope journal CAS to the effect", () => {
    const result = { trace: [
      { type: "effect", data: { name: "other", state: "resolved", idempotencyKey: "wanted" } },
      { type: "effect", data: { name: "write", state: "resolved", idempotencyKey: "actual" } },
    ], ambiguity: [] };
    expect(() => expectEffect("write").idempotencyKey("wanted", result)).toThrow("was not observed");
    expect(() => expectEffect("write").idempotencyKey("actual", result)).not.toThrow();
    expect(() => expectEffect("write").journalCas({ trace: [{ type: "durability", data: { operation: "ack", effect: "other" } }], ambiguity: [] })).toThrow("exactly one scoped journal-write");
  });

  test("executed mediated effects preserve idempotency keys at the public boundary", async () => {
    const result = await runScenario(scenario("idempotency-executed", { steps: [step("charge", { runnerBinding: "test:charge:v1", run: (runtime) => runtime.effect("charge", () => "ok", { idempotencyKey: "k-1" }) })] }));
    expect(result.status).toBe("finished");
    expect(() => expectEffect("charge").idempotencyKey("k-1", result)).not.toThrow();
    expect(() => expectEffect("charge").idempotencyKey("wrong", result)).toThrow("was not observed");
  });

  test("caller-forged process identity is rejected even with a static marker and truthy handshake", async () => {
    const child = spawn("sh", ["-c", "printf 'SMITHERS_ENGINE_HANDSHAKE=runWorkflow:%s\\n' \"$0\"; sleep 30", "fake-engineChildRunner.ts"], { stdio: ["ignore", "pipe", "ignore"] });
    const forged = async () => ({
      pid: child.pid!, child,
      handshake: async () => "caller-forged" as unknown as string,
      kill: (signal?: string) => { child.kill(signal as NodeJS.Signals | undefined); },
      close: () => undefined,
    });
    const adapter = realProcessAdapter({ runnerPath: "/repo/e2e/harness/engineChildRunner.ts", probe: forged, spawn: forged });
    const result = await runScenario(scenario("forged-process", { steps: [step("run")] }), { harness: e2eHarness({ adapter }) });
    expect(result.status).toBe("capability-failure");
    expect(result.error?.code).toBe("ADMISSION_FAILED");
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  test("operation cut points are inert until their operation is observed", async () => {
    const result = await runScenario(scenario("operation-conformance", { steps: [step("noop")], faults: [fault("attempt", "before-task", "attempt-write"), fault("event", "before-task", "event-append")] }));
    expect(result.status).toBe("finished");
    expect(result.error).toBeUndefined();
    expect(result.ambiguity).toHaveLength(0);
    expect(result.trace.some((event) => event.type === "fault")).toBe(false);
  });

  test("operation cut points fire only at their real transitions", async () => {
    const attempt = await runScenario(scenario("attempt-transition", { steps: [step("write", { runnerBinding: "test:attempt-transition:write:v1", run: (runtime) => runtime.effect("write", () => "ok") })], faults: [fault("attempt", "before-task", "attempt-write")] }));
    expect(attempt.status).toBe("failed");
    expect(attempt.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const event = await runScenario(scenario("event-transition", { steps: [step("wait", { runnerBinding: "test:event-transition:wait:v1", run: (runtime) => runtime.sleep(1) })], faults: [fault("event", "before-task", "event-append")] }));
    expect(event.status).toBe("failed");
    expect(event.error?.code).toBe("DURABILITY_FAULT_INJECTED");
  });

  test("mixed ready barriers retain step identity and gate downstream output", async () => {
    const calls: string[] = [];
    const result = await runScenario(scenario("mixed-barrier", {
      steps: [
        step("x", { runnerBinding: "test:mixed-barrier:x:v1", run: () => { calls.push("x"); return "X"; } }),
        step("b", { runnerBinding: "test:mixed-barrier:b:v1", run: () => { calls.push("b"); return "B"; } }),
        step("c", { runnerBinding: "test:mixed-barrier:c:v1", run: () => { calls.push("c"); return "C"; } }),
        step("after", { dependsOn: ["b", "c"], runnerBinding: "test:mixed-barrier:after:v1", run: () => { calls.push("after"); return "after"; } }),
      ],
      barriers: [barrier("gate", ["b", "c"], 4)],
    }), { controlLog: [{ type: "release-barrier", barrier: "gate" }] });
    expect(result.status).toBe("finished");
    expect(result.outputs).toEqual({ x: "X", b: "B", c: "C", after: "after" });
    expect(calls.indexOf("after")).toBeGreaterThan(calls.indexOf("b"));
    expect(calls.indexOf("after")).toBeGreaterThan(calls.indexOf("c"));
  });

  test("same-source captured executable bindings fail closed", () => {
    const make = (value: number) => () => ({ value: String(value) });
    expect(() => step("one", { run: make(1) })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    expect(() => step("two", { run: make(2) })).toThrow("RUNNER_BINDING_AMBIGUOUS");
  });

  test("ordered barrier release parks parties before callbacks resume", async () => {
    const events: string[] = [];
    const result = await runScenario(scenario("barrier-rendezvous", {
      steps: [
        step("left", { runnerBinding: "test:barrier:left:v1", run: () => { events.push("left-callback"); return "left"; } }),
        step("right", { runnerBinding: "test:barrier:right:v1", run: () => { events.push("right-callback"); return "right"; } }),
        step("after", { runnerBinding: "test:barrier:after:v1", dependsOn: ["left", "right"], run: () => { events.push("after"); return "after"; } }),
      ],
      barriers: [barrier("gate", ["left", "right"], 4)],
    }), { controlLog: [{ type: "release-barrier", barrier: "gate" }] });
    expect(result.status).toBe("finished");
    const parked = result.trace.findIndex((event) => event.type === "barrier" && (event.data as { state?: string } | undefined)?.state === "parked");
    const released = result.trace.findIndex((event) => event.type === "barrier" && (event.data as { state?: string } | undefined)?.state === "released");
    expect(parked).toBeGreaterThanOrEqual(0);
    expect(released).toBeGreaterThan(parked);
    expect(events.filter((event) => event.endsWith("callback"))).toHaveLength(2);
    expect(events.at(-1)).toBe("after");
  });

  test("property captures cannot share a source-derived replay identity", () => {
    const make = (box: { value: string }) => () => box.value;
    expect(() => step("one", { run: make({ value: "A" }) })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    expect(() => step("two", { run: make({ value: "B" }) })).toThrow("RUNNER_BINDING_AMBIGUOUS");
  });

  test("shadowed intrinsic names are treated as captured executable state", () => {
    const make = (Math: { value: string }) => () => Math.value;
    expect(() => step("math-a", { run: make({ value: "A" }) })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    expect(() => step("math-b", { run: make({ value: "B" }) })).toThrow("RUNNER_BINDING_AMBIGUOUS");
  });

  test("lexical meta-properties fail closed: new.target answers called-versus-constructed from identical source", () => {
    function make() { return () => (new.target ? "constructed" : "called"); }
    const construct = make as unknown as new () => () => string;
    const called = make();
    const constructed = new construct();
    // Sanity: the two runners genuinely diverge at runtime while sharing
    // byte-identical source — exactly why an anonymous identity is unsound.
    expect((called as () => string)()).toBe("called");
    expect((constructed as () => string)()).toBe("constructed");
    expect(() => step("called", { run: called })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    expect(() => step("constructed", { run: constructed })).toThrow("RUNNER_BINDING_AMBIGUOUS");
  });

  test("indirect capability acquisition through the prototype chain fails closed", () => {
    // Sol's counterexample family: byte-identical source that reaches the
    // Function constructor via member access and evaluates process-dependent
    // source. Sanity first: the computed form genuinely diverges at runtime.
    process.env.SMITHERS_TESTING_CAPABILITY_PROBE = "A";
    const computed = () => (({}) as unknown as Record<string, Record<string, (source: string) => () => string>>)["constructor"]!["constructor"]!("return process.env.SMITHERS_TESTING_CAPABILITY_PROBE")();
    expect(computed()).toBe("A");
    process.env.SMITHERS_TESTING_CAPABILITY_PROBE = "B";
    expect(computed()).toBe("B");
    expect(() => step("computed", { run: computed })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    expect(() => step("dotted", { run: () => (({}).constructor.constructor as (source: string) => () => string)("return process.env.SMITHERS_TESTING_CAPABILITY_PROBE")() })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    expect(() => step("param-rooted", { run: (runtime) => ((runtime as unknown as { constructor: { constructor: (source: string) => () => string } }).constructor.constructor("return process.env.SMITHERS_TESTING_CAPABILITY_PROBE")()) })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    delete process.env.SMITHERS_TESTING_CAPABILITY_PROBE;
  });

  test("member access of any form requires an explicit runnerBinding — including taskRuntime use", async () => {
    // Deliberate behavior change: `runtime.effect(...)` is member access, so
    // the authoring pattern now carries an explicit binding. Bound, it runs.
    expect(() => step("unbound", { run: (runtime) => runtime.effect("write", () => "ok") })).toThrow("RUNNER_BINDING_AMBIGUOUS");
    const result = await runScenario(scenario("bound-runtime", { steps: [step("write", { runnerBinding: "test:bound-runtime:write:v1", run: (runtime) => runtime.effect("write", () => "ok") })] }));
    expect(result.status).toBe("finished");
    expect(result.outputs.write).toBe("ok");
  });

  test("barrier parties never enter callbacks before release", async () => {
    const calls: string[] = [];
    const result = await runScenario(scenario("barrier-no-release", {
      steps: [step("party", { runnerBinding: "test:barrier:no-release:v1", run: () => { calls.push("entered"); return "done"; } })],
      barriers: [barrier("gate", ["party"], 1)],
    }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("BARRIER_TIMEOUT");
    expect(calls).toEqual([]);
  });

  test("completion CAS cut point fires for a plain completed callback", async () => {
    const calls: string[] = [];
    const result = await runScenario(scenario("completion-before", {
      steps: [step("plain", { runnerBinding: "test:completion:plain:v1", run: () => { calls.push("entered"); return "done"; } })],
      faults: [fault("completion", "before-task", "completion-cas")],
    }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    expect(calls).toEqual(["entered"]);
  });

  test("operation faults stay inert until their named transition occurs", async () => {
    const result = await runScenario(scenario("attempt-no-op", {
      steps: [step("noop")],
      faults: [fault("attempt-before", "before-task", "attempt-write")],
    }));
    expect(result.status).toBe("finished");
    expect(result.ambiguity).toEqual([]);
    expect(result.trace.some((event) => event.type === "durability")).toBe(false);
  });

  test("pending controls participate in failure replay identity", async () => {
    const ast = scenario("pending-control", { steps: [step("noop")] });
    const clean = await runScenario(ast);
    const failed = await runScenario(ast, { controlLog: [{ type: "resolve-effect", effect: "missing", outcome: "succeed" }] });
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("CONTROL_UNCONSUMED");
    expect(failed.replayIdentity).not.toBe(clean.replayIdentity);
  });
});
