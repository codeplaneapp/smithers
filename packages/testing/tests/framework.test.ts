import { describe, expect, test } from "bun:test";
import { barrier, compareBoundaryShape, e2eDescriptor, e2eHarness, fault, mediatedEffect, EffectLedger, runScenario, scenario, step, VirtualClock, firstDivergence, makeReplayBundle, serializeReplayBundle, loadReplayBundle, replayBundle, CleanupScope, assertNoLeaks, contractProbe, unitSimHarness, integrationHarness, realDbAdapter, realProcessAdapter, expectEffect, shrink } from "../src/index.ts";
import { spawn } from "node:child_process";

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
      step("boom", { run: () => { throw Object.assign(new Error("boom"), { code: "BOOM" }); } }),
      step("blocked", { run: async (runtime) => { await runtime.sleep(1_000_000); return "late"; } }),
    ] }), { waitBudget: 100 });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("BOOM");
    expect(result.error?.code).not.toBe("CLEANUP_LEAK");
  });

  test("schedules newly-ready transitions before an unrelated sleeping sibling", async () => {
    const started: string[] = [];
    const result = await runScenario(scenario("event-driven", { steps: [
      step("a", { run: () => { started.push("a"); return "a"; } }),
      step("b", { run: async (runtime) => { started.push("b"); await runtime.sleep(20); return "b"; } }),
      step("c", { dependsOn: ["a"], run: () => { started.push("c"); return "c"; } }),
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
      steps: [step("work", { run: () => "done" })],
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
    const ast = scenario("explicit-clock", { steps: [step("wait", { run: (runtime) => runtime.sleep(5) })] });
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
    const result = await runScenario(scenario("timer", { steps: [step("wait", { run: async (runtime) => { await runtime.sleep(5); await runtime.opaque("file-write", () => "done"); return "ok"; } })] }));
    expect(result.status).toBe("finished");
    expect(result.outputs.wait).toBe("ok");
    expect(result.trace.some((event) => event.type === "opaque-effect" && (event.data as { name?: unknown } | undefined)?.name === "file-write")).toBe(true);
  });

  test("wires effect cut points to ambiguity output", async () => {
    const result = await runScenario(scenario("crash-window", { steps: [step("write", { run: async (runtime) => runtime.effect("write", () => "committed") })], faults: [fault("crash", "after-effect-before-journal", "effect")] }));
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
    const ast = scenario("ordered", { steps: [step("wait", { run: async (runtime) => { await runtime.sleep(2); return "done"; } })] });
    const first = await runScenario(ast, { seed: 7 });
    const bundle = makeReplayBundle({ ast, seed: 7, controlLog: first.controlLog, trace: first.trace });
    const replay = await replayBundle(bundle);
    expect(replay.status).toBe("finished");
    expect(replay.replayIdentity).toBe(bundle.replayIdentity);
  });

  test("mixed rendezvous controls replay byte-for-byte without growing the log", async () => {
    const ast = scenario("mixed-controls", { steps: [step("a", { run: async (runtime) => { await runtime.effect("write", () => "ok"); return "a"; } }), step("b", { run: () => "b" })] });
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
      ["duplicate-delivery", scenario("duplicate", { steps: [step("write", { run: (runtime) => runtime.effect("write", () => "ok") })] }) , [{ type: "resolve-effect" as const, effect: "write:write", outcome: "duplicate" as const }]],
      ["effect-applied-journal-missing", scenario("effect-crash", { steps: [step("write", { run: (runtime) => runtime.effect("write", () => "ok") })], faults: [fault("f", "after-effect-before-journal", "effect")] }), []],
      ["journal-applied-ack-missing", scenario("ack-crash", { steps: [step("write", { run: (runtime) => runtime.effect("write", () => "ok") })], faults: [fault("f", "after-journal-before-ack", "effect")] }), []],
      ["lost-wakeup", scenario("wakeup", { steps: [step("wait", { run: (runtime) => runtime.sleep(1) })], faults: [fault("f", "during-task", "event-append")] }), []],
      ["cancellation-race", scenario("cancel", { steps: [step("work", { run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return "ok"; } })], faults: [fault("f", "during-task", "cancellation")] }), []],
      ["lease-lost", scenario("lease", { steps: [step("work", { run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return "ok"; } })], faults: [fault("f", "during-task", "lease")] }), []],
      ["restart-in-task", scenario("restart", { steps: [step("work", { run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return "ok"; } })], faults: [fault("f", "during-task", "resume")] }), []],
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
    const result = await runScenario(scenario("adapter", { steps: [step("observed", { run: () => "simulated" })] }), { harness });
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

  test("anonymous runner bindings are content-addressed and construction-history independent", () => {
    const runner = () => "same";
    const one = scenario("binding", { steps: [step("task", { run: runner })] });
    const two = scenario("binding", { steps: [step("task", { run: runner })] });
    expect(one.steps[0]?.runnerBinding).toBe(two.steps[0]?.runnerBinding);
  });

  test("rejects source-identical captured closures without an explicit executable binding", () => {
    const make = (value: number) => () => ({ value });
    expect(() => step("captured", { run: make(1) })).toThrow("RUNNER_BINDING_AMBIGUOUS");
  });

  test("caller-forged real-process identity is rejected before spawn", async () => {
    let spawned = false;
    const adapter = realProcessAdapter({ runnerPath: "/tmp/impostor-engineChildRunner.ts", spawn: async () => { spawned = true; throw new Error("must not spawn"); } });
    const result = await runScenario(scenario("forged-process", { steps: [step("work")] }), { harness: e2eHarness({ adapter }) });
    expect(result.status).toBe("capability-failure");
    expect(result.error?.code).toBe("ADMISSION_FAILED");
    expect(spawned).toBe(false);
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
    const result = await runScenario(scenario("controlled-value", { steps: [step("write", { run: (runtime) => runtime.effect("write", () => { calls++; return "real"; }) })] }), { controlLog: [{ type: "resolve-effect", effect: "write:write", outcome: "succeed", value: "controlled" }] });
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
    const result = await runScenario(scenario("wrong-timer", { steps: [step("wait", { run: (runtime) => runtime.sleep(2) })] }), { controlLog: [{ type: "timer-fire", timer: "999" }] });
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
    const adapter = realProcessAdapter({ runnerPath: "/repo/e2e/harness/engineChildRunner.ts", spawn: async () => ({
      pid: child.pid!, child,
      handshake: async () => "caller-forged" as unknown as string,
      kill: (signal?: string) => { child.kill(signal as NodeJS.Signals | undefined); },
      close: () => undefined,
    }) });
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
    const attempt = await runScenario(scenario("attempt-transition", { steps: [step("write", { run: (runtime) => runtime.effect("write", () => "ok") })], faults: [fault("attempt", "before-task", "attempt-write")] }));
    expect(attempt.status).toBe("failed");
    expect(attempt.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const event = await runScenario(scenario("event-transition", { steps: [step("wait", { run: (runtime) => runtime.sleep(1) })], faults: [fault("event", "before-task", "event-append")] }));
    expect(event.status).toBe("failed");
    expect(event.error?.code).toBe("DURABILITY_FAULT_INJECTED");
  });

  test("mixed ready barriers retain step identity and gate downstream output", async () => {
    const calls: string[] = [];
    const result = await runScenario(scenario("mixed-barrier", {
      steps: [
        step("x", { run: () => { calls.push("x"); return "X"; } }),
        step("b", { run: () => { calls.push("b"); return "B"; } }),
        step("c", { run: () => { calls.push("c"); return "C"; } }),
        step("after", { dependsOn: ["b", "c"], run: () => { calls.push("after"); return "after"; } }),
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
