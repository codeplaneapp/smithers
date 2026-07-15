import { describe, expect, test } from "bun:test";
import { barrier, compareBoundaryShape, e2eDescriptor, e2eHarness, fault, mediatedEffect, EffectLedger, runScenario, scenario, step, VirtualClock, firstDivergence, makeReplayBundle, serializeReplayBundle, loadReplayBundle, replayBundle, CleanupScope, assertNoLeaks, contractProbe, unitSimHarness, integrationHarness, realDbAdapter, realProcessAdapter, expectEffect } from "../src/index.ts";
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
    expect(replay.replayIdentity).toBe(first.replayIdentity);
    expect(replay.trace).toEqual(first.trace);
  });

  test("restart-in-task performs a resumed attempt", async () => {
    let attempts = 0;
    const result = await runScenario(scenario("restart", { steps: [step("work", { run: () => ++attempts })], faults: [fault("restart", "during-task", "resume")] }));
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
      ["cancellation-race", scenario("cancel", { steps: [step("work", { run: () => "ok" })], faults: [fault("f", "during-task", "cancellation")] }), []],
      ["lease-lost", scenario("lease", { steps: [step("work", { run: () => "ok" })], faults: [fault("f", "during-task", "lease")] }), []],
      ["restart-in-task", scenario("restart", { steps: [step("work", { run: () => "ok" })], faults: [fault("f", "during-task", "resume")] }), []],
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

  test("runner bindings participate in replay identity", () => {
    const one = scenario("binding", { steps: [step("task", { run: () => "one" })] });
    const two = scenario("binding", { steps: [step("task", { run: () => "two" })] });
    expect(one.steps[0]?.runnerBinding).not.toBe(two.steps[0]?.runnerBinding);
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
});
