import { describe, expect, test } from "bun:test";
import * as sourceEntry from "../src/index.ts";
import { compileScenario, e2eHarness, fault, integrationHarness, realDbAdapter, realProcessAdapter, runScenario, scenario, step, type ScenarioAst, type ScenarioFault } from "../src/index.ts";
import { registerTrustedAdapter, type AdapterFaultContext } from "../src/harness/Harness.ts";

/**
 * Table-driven conformance over EVERY compiler-admitted operation/phase pair,
 * exercised against BOTH the TypeScript source and the COMMITTED shipped
 * artifact. Rows per pair:
 *  - occurrence: a unit-sim scenario that actually drives the operation must
 *    apply the fault at that transition (or emit its ambiguity).
 *  - non-occurrence: a scenario in which ANOTHER operation is genuinely in
 *    flight (or the callback fails/completes first) must leave the declared
 *    fault inert — declared cut points are never simulated stand-ins.
 *  - controlled-fault: an inject-fault control ARMS the declared fault and it
 *    fires only at the same transition the declared row fires at.
 *  - armed non-occurrence: an armed fault whose operation never transitions
 *    is an explicit CONTROL_UNCONSUMED failure, never a fault or ambiguity.
 *  - unsupported-harness admission: a real harness whose adapter cannot
 *    execute the pair must fail admission BEFORE opening any resource.
 * Real-adapter invocation rows live in
 * e2e/testing-framework/cutpoint-conformance.test.ts against a live SmithersDb.
 */
const shippedPath = Bun.resolveSync("@smithers-orchestrator/testing", import.meta.dir);
const shippedEntry = (await import(shippedPath)) as typeof sourceEntry;
const ENTRIES = [
  { entry: "source" as const, M: sourceEntry },
  { entry: "shipped" as const, M: shippedEntry },
];

type Pair = Readonly<{ operation: ScenarioFault["operation"]; phase: ScenarioFault["phase"]; drive: "plain" | "effect" | "sleep" | "slow" | "retry"; expects: "fault" | "restart" | "lost-wakeup"; ambiguity?: string; inert: "empty" | "noop" | "in-flight" | "in-flight-fails" | "completes-first" }>;
// Mirrors compile.ts validPairs exactly; the cross-product drift guard below
// fails if the compiler admits a pair this table does not cover (or vice
// versa) for ANY operation/phase combination, not just the listed rows.
const PAIRS: readonly Pair[] = [
  { operation: "task", phase: "before-task", drive: "plain", expects: "fault", inert: "empty" },
  { operation: "task", phase: "during-task", drive: "slow", expects: "fault", inert: "empty" },
  { operation: "task", phase: "after-task", drive: "plain", expects: "fault", inert: "empty" },
  { operation: "effect", phase: "before-task", drive: "effect", expects: "fault", inert: "in-flight" },
  { operation: "effect", phase: "during-task", drive: "effect", expects: "fault", inert: "in-flight" },
  { operation: "effect", phase: "after-effect-before-journal", drive: "effect", expects: "fault", ambiguity: "effect-applied-journal-missing", inert: "in-flight" },
  { operation: "effect", phase: "after-journal-before-ack", drive: "effect", expects: "fault", ambiguity: "journal-applied-ack-missing", inert: "in-flight" },
  { operation: "effect", phase: "after-ack", drive: "effect", expects: "fault", inert: "in-flight" },
  { operation: "attempt-write", phase: "before-task", drive: "effect", expects: "fault", inert: "in-flight" },
  { operation: "attempt-write", phase: "after-journal-before-ack", drive: "effect", expects: "fault", ambiguity: "journal-applied-ack-missing", inert: "in-flight" },
  { operation: "event-append", phase: "before-task", drive: "sleep", expects: "fault", inert: "in-flight" },
  // Wakeup loss fires at the REGISTERED wakeup's append transition inside the
  // wait middleware: a during-task drop surfaces as the injected fault, an
  // after-task drop as the lost wakeup itself — both with the ambiguity.
  { operation: "event-append", phase: "during-task", drive: "sleep", expects: "fault", ambiguity: "lost-wakeup", inert: "in-flight" },
  { operation: "event-append", phase: "after-task", drive: "sleep", expects: "lost-wakeup", ambiguity: "lost-wakeup", inert: "in-flight" },
  // All three completion-cas phases are driven by a COMPLETED PLAIN callback:
  // the terminal completion transition, never the mediated-effect journal.
  { operation: "completion-cas", phase: "before-task", drive: "plain", expects: "fault", inert: "in-flight-fails" },
  { operation: "completion-cas", phase: "after-journal-before-ack", drive: "plain", expects: "fault", ambiguity: "journal-applied-ack-missing", inert: "in-flight-fails" },
  { operation: "completion-cas", phase: "after-task", drive: "plain", expects: "fault", inert: "in-flight-fails" },
  { operation: "heartbeat", phase: "during-task", drive: "slow", expects: "fault", ambiguity: "lease-lost", inert: "completes-first" },
  { operation: "lease", phase: "during-task", drive: "slow", expects: "fault", ambiguity: "lease-lost", inert: "completes-first" },
  { operation: "cancellation", phase: "during-task", drive: "slow", expects: "fault", ambiguity: "cancellation-race", inert: "completes-first" },
  { operation: "resume", phase: "before-task", drive: "plain", expects: "fault", inert: "noop" },
  { operation: "resume", phase: "during-task", drive: "retry", expects: "restart", ambiguity: "restart-in-task", inert: "completes-first" },
];
const ALL_OPERATIONS: readonly ScenarioFault["operation"][] = ["task", "effect", "attempt-write", "event-append", "completion-cas", "heartbeat", "lease", "resume", "cancellation"];
const ALL_PHASES: readonly ScenarioFault["phase"][] = ["before-task", "during-task", "after-task", "after-effect-before-journal", "after-journal-before-ack", "after-ack"];

const REAL_DB_EXECUTABLE = new Set([
  "completion-cas:before-task", "completion-cas:after-task", "completion-cas:after-journal-before-ack",
  "resume:before-task", "heartbeat:during-task", "cancellation:during-task",
]);
const REAL_PROCESS_EXECUTABLE = new Set(["resume:during-task"]);

const driveScenario = (M: typeof sourceEntry, pair: Pair, name: string): ScenarioAst => {
  const declared = M.fault("probe", pair.phase, pair.operation);
  const binding = `test:conformance:${name}:v1`;
  switch (pair.drive) {
    case "plain": return M.scenario(name, { steps: [M.step("work", { runnerBinding: binding, run: () => "done" })], faults: [declared] });
    case "effect": return M.scenario(name, { steps: [M.step("work", { runnerBinding: binding, run: (runtime) => runtime.effect("write", () => "ok") })], faults: [declared] });
    case "sleep": return M.scenario(name, { steps: [M.step("work", { runnerBinding: binding, run: (runtime) => runtime.sleep(1) })], faults: [declared] });
    case "slow": return M.scenario(name, { steps: [M.step("work", { runnerBinding: binding, run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return "ok"; } })], faults: [declared] });
    case "retry": {
      // The restart cut point re-executes the task; the second attempt must be
      // able to complete without a host timer so the kernel can settle.
      let attempts = 0;
      return M.scenario(name, { steps: [M.step("work", { runnerBinding: binding, run: async () => { attempts++; if (attempts === 1) await new Promise((resolve) => setTimeout(resolve, 10)); return "ok"; } })], faults: [declared] });
    }
  }
};

const inertScenario = (M: typeof sourceEntry, pair: Pair, name: string): ScenarioAst => {
  const declared = M.fault("probe", pair.phase, pair.operation);
  const binding = `test:conformance:${name}:v1`;
  switch (pair.inert) {
    // The task operation transitions whenever any step exists, so its
    // non-occurrence scenario is empty.
    case "empty": return M.scenario(name, { steps: [], faults: [declared] });
    // resume:before-task rendezvouses only with an executable runner.
    case "noop": return M.scenario(name, { steps: [M.step("noop")], faults: [declared] });
    // Sol's round-7 probe shape: the callback is GENUINELY in flight across
    // more than four nested host microtasks while invoking neither
    // taskRuntime.effect nor taskRuntime.sleep — the declared operation never
    // transitions and interrupting this in-flight work would fabricate one.
    case "in-flight": return M.scenario(name, { steps: [M.step("work", { runnerBinding: binding, run: async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); return "ok"; } })], faults: [declared] });
    // The callback performs in-flight work and then fails on its own: no
    // terminal completion transition ever commits.
    case "in-flight-fails": return M.scenario(name, { steps: [M.step("work", { runnerBinding: binding, run: async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); throw Object.assign(new Error("callback failed before completion"), { code: "CALLBACK_OWN_FAILURE" }); } })], faults: [declared] });
    // The callback reaches its terminal state before any crash window opens:
    // the in-flight transition the fault names never occurred.
    case "completes-first": return M.scenario(name, { steps: [M.step("work", { runnerBinding: binding, run: () => "done" })], faults: [declared] });
  }
};

const operationEvents = (result: Awaited<ReturnType<typeof runScenario>>, operation: string) =>
  result.trace.filter((event) => event.type === "durability" && (event.data as { operation?: string }).operation === operation);

describe("cut-point conformance table", () => {
  for (const { entry, M } of ENTRIES) {
    test(`[${entry}] drift guard: compiler admission over the FULL operation×phase cross product matches the table`, () => {
      const tabled = new Set(PAIRS.map((pair) => `${pair.operation}:${pair.phase}`));
      for (const operation of ALL_OPERATIONS) {
        for (const phase of ALL_PHASES) {
          const compiled = M.compileScenario(M.scenario("admit", { steps: [M.step("noop")], faults: [M.fault("probe", phase, operation)] }));
          expect({ entry, pair: `${operation}:${phase}`, ok: compiled.ok }).toEqual({ entry, pair: `${operation}:${phase}`, ok: tabled.has(`${operation}:${phase}`) });
          if (!compiled.ok) expect(compiled.diagnostics.some((d) => d.code === "UNSUPPORTED_FAULT_CUT_POINT")).toBe(true);
        }
      }
    });

    test(`[${entry}] occurrence: every pair applies at its driven transition on unit-sim`, async () => {
      for (const pair of PAIRS) {
        const key = `${pair.operation}:${pair.phase}`;
        const result = await M.runScenario(driveScenario(M, pair, `${entry}-occ-${pair.operation}-${pair.phase}`), { waitBudget: 5_000 });
        if (pair.expects === "restart") {
          expect({ entry, key, status: result.status }).toEqual({ entry, key, status: "finished" });
        } else if (pair.expects === "lost-wakeup") {
          expect({ entry, key, status: result.status, code: result.error?.code }).toEqual({ entry, key, status: "failed", code: "LOST_WAKEUP" });
        } else {
          expect({ entry, key, status: result.status, code: result.error?.code }).toEqual({ entry, key, status: "failed", code: "DURABILITY_FAULT_INJECTED" });
        }
        if (pair.ambiguity) expect({ entry, key, ambiguity: result.ambiguity.some((item) => item.outcome === pair.ambiguity) }).toEqual({ entry, key, ambiguity: true });
      }
    }, { timeout: 60_000 });

    test(`[${entry}] non-occurrence: every pair stays inert while other work is genuinely in flight`, async () => {
      for (const pair of PAIRS) {
        const key = `${pair.operation}:${pair.phase}`;
        const result = await M.runScenario(inertScenario(M, pair, `${entry}-inert-${pair.operation}-${pair.phase}`), { waitBudget: 5_000 });
        if (pair.inert === "in-flight-fails") {
          // The callback's OWN failure surfaces; the declared fault never fires.
          expect({ entry, key, status: result.status, code: result.error?.code }).toEqual({ entry, key, status: "failed", code: "CALLBACK_OWN_FAILURE" });
        } else {
          expect({ entry, key, status: result.status, code: result.error?.code }).toEqual({ entry, key, status: "finished", code: undefined });
        }
        expect({ entry, key, ambiguity: result.ambiguity }).toEqual({ entry, key, ambiguity: [] });
        expect({ entry, key, faultEvents: result.trace.some((event) => event.type === "fault") }).toEqual({ entry, key, faultEvents: false });
        expect({ entry, key, operationEvents: operationEvents(result, pair.operation) }).toEqual({ entry, key, operationEvents: [] });
      }
    }, { timeout: 60_000 });

    test(`[${entry}] controlled-fault: an armed pair fires at the SAME transition its declared row fires at`, async () => {
      for (const pair of PAIRS) {
        const key = `${pair.operation}:${pair.phase}`;
        const result = await M.runScenario(driveScenario(M, pair, `${entry}-ctl-${pair.operation}-${pair.phase}`), { waitBudget: 5_000, controlLog: [{ type: "inject-fault", fault: "probe" }] });
        if (pair.expects === "restart") {
          // The armed restart fired at its transition and the task resumed:
          // the control was OBSERVED, so no unconsumed-control failure.
          expect({ entry, key, status: result.status }).toEqual({ entry, key, status: "finished" });
        } else if (pair.expects === "lost-wakeup") {
          expect({ entry, key, status: result.status, code: result.error?.code }).toEqual({ entry, key, status: "failed", code: "LOST_WAKEUP" });
        } else {
          expect({ entry, key, status: result.status, code: result.error?.code }).toEqual({ entry, key, status: "failed", code: "DURABILITY_FAULT_INJECTED" });
        }
        if (pair.ambiguity) expect({ entry, key, ambiguity: result.ambiguity.some((item) => item.outcome === pair.ambiguity) }).toEqual({ entry, key, ambiguity: true });
        expect({ entry, key, armed: result.controlLog.some((control) => control.type === "inject-fault" && control.fault === "probe") }).toEqual({ entry, key, armed: true });
      }
    }, { timeout: 60_000 });

    test(`[${entry}] armed non-occurrence: an armed fault whose operation never transitions fails as an unconsumed control, never as a fault`, async () => {
      for (const pair of PAIRS) {
        const key = `${pair.operation}:${pair.phase}`;
        const result = await M.runScenario(inertScenario(M, pair, `${entry}-armed-${pair.operation}-${pair.phase}`), { waitBudget: 5_000, controlLog: [{ type: "inject-fault", fault: "probe" }] });
        // The armed fault never fires: either the control is reported
        // unconsumed, or the callback's own failure wins first — never
        // DURABILITY_FAULT_INJECTED.
        const expectedCode = pair.inert === "in-flight-fails" ? "CALLBACK_OWN_FAILURE" : "CONTROL_UNCONSUMED";
        expect({ entry, key, status: result.status, code: result.error?.code }).toEqual({ entry, key, status: "failed", code: expectedCode });
        expect({ entry, key, ambiguity: result.ambiguity }).toEqual({ entry, key, ambiguity: [] });
        expect({ entry, key, operationEvents: operationEvents(result, pair.operation) }).toEqual({ entry, key, operationEvents: [] });
      }
    }, { timeout: 60_000 });
  }

  test("unsupported-harness admission: inexecutable pairs fail before any resource opens", async () => {
    let dbOpened = 0;
    let processSpawned = 0;
    let processProbed = 0;
    for (const pair of PAIRS) {
      const key = `${pair.operation}:${pair.phase}`;
      const ast = scenario(`admission-${pair.operation}-${pair.phase}`, { steps: [step("noop")], faults: [fault("probe", pair.phase, pair.operation)] });
      if (!REAL_DB_EXECUTABLE.has(key)) {
        const adapter = realDbAdapter({ open: async () => { dbOpened++; throw new Error("must not open"); } });
        const result = await runScenario(ast, { harness: integrationHarness({ adapter }) });
        expect({ key, status: result.status, code: result.error?.code }).toEqual({ key, status: "capability-failure", code: "ADMISSION_FAILED" });
      }
      if (!REAL_PROCESS_EXECUTABLE.has(key)) {
        const adapter = realProcessAdapter({ runnerPath: "/tmp/conformance-not-a-runner.ts", probe: async () => { processProbed++; throw new Error("must not probe"); }, spawn: async () => { processSpawned++; throw new Error("must not spawn"); } });
        const result = await runScenario(ast, { harness: e2eHarness({ adapter }) });
        expect({ key, status: result.status, code: result.error?.code }).toEqual({ key, status: "capability-failure", code: "ADMISSION_FAILED" });
      }
    }
    expect(dbOpened).toBe(0);
    expect(processSpawned).toBe(0);
    expect(processProbed).toBe(0);
  }, { timeout: 60_000 });
});

describe("Sol round-7 cut-point probes (verbatim shapes)", () => {
  // Probes 1 and 2: a callback in flight across nested host microtasks that
  // invokes neither taskRuntime.effect nor taskRuntime.sleep previously
  // FAILED with DURABILITY_FAULT_INJECTED for effect:during-task and
  // event-append:during-task — the kernel interrupted the callback and
  // fabricated an operation occurrence. The named operation never transitions,
  // so the callback's own completion must stand.
  for (const operation of ["effect", "event-append"] as const) {
    test(`a slow non-driving callback finishes despite a declared ${operation}:during-task fault`, async () => {
      const result = await runScenario(scenario(`sol7-${operation}`, {
        steps: [step("work", { runnerBinding: `test:sol7:${operation}:v1`, run: async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); return "ok"; } })],
        faults: [fault("probe", "during-task", operation)],
      }));
      expect(result.status).toBe("finished");
      expect(result.outputs.work).toBe("ok");
      expect(result.ambiguity).toEqual([]);
      expect(result.trace.filter((event) => event.type === "durability")).toEqual([]);
    });
  }

  test("a runnerless no-op with an armed completion-cas:before-task fault fails as CONTROL_UNCONSUMED, not at task entry", async () => {
    // Sol's probe 3: the armed control previously fired at task entry as a
    // task fault although no completion transition occurred.
    const result = await runScenario(scenario("sol7-armed-noop", { steps: [step("noop")], faults: [fault("probe", "before-task", "completion-cas")] }), { controlLog: [{ type: "inject-fault", fault: "probe" }] });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CONTROL_UNCONSUMED");
    expect(result.ambiguity).toEqual([]);
    expect(result.trace.filter((event) => event.type === "durability")).toEqual([]);
  });
});

describe("real-process middleware routing (unit simulation of the adapter contract)", () => {
  // The REAL invocation rows for resume:during-task live in
  // e2e/testing-framework/cutpoint-conformance.test.ts against a live
  // engineChildRunner child. This unit simulation pins the runScenario
  // middleware contract itself: the runWorkflow transition maps to the
  // `resume` operation, injectFault fires at that ONE transition with the
  // full AdapterFaultContext, and the durability receipt carries the
  // observation. registerTrustedAdapter is internal to the package — package
  // consumers cannot forge this registration.
  const observation = { terminatedBy: "SIGKILL", preKillEffectApplied: true, journalWritten: false, outputPersisted: false, resumed: true, resumedStatus: "finished", resumedOutputPersisted: true } as const;
  const makeStub = (result: unknown) => {
    const calls: { runStep: unknown[]; injectFault: { fault: string; context: AdapterFaultContext | undefined }[] } = { runStep: [], injectFault: [] };
    const adapter = registerTrustedAdapter({
      identity: "stub:real-process-middleware",
      verifiedProductionIdentity: "stub:middleware-routing",
      supportedCutPoints: new Set(["resume:during-task"]),
      admissionProbe: () => undefined,
      runStep: (operation) => { calls.runStep.push(operation); return 4242; },
      injectFault: (declared, context) => { calls.injectFault.push({ fault: declared.id, context }); return result; },
    }, "e2e-real-process");
    return { adapter, calls };
  };
  const routingScenario = () => scenario("routing", { steps: [step("work")], faults: [fault("sigkill", "during-task", "resume")] });

  test("resume:during-task fires through the ONE transition middleware with context and receipt", async () => {
    const { adapter, calls } = makeStub(observation);
    const result = await runScenario(routingScenario(), { harness: e2eHarness({ adapter }) });
    expect(result.status).toBe("finished");
    expect(calls.runStep).toEqual(["runWorkflow"]);
    expect(calls.injectFault).toHaveLength(1);
    expect(calls.injectFault[0]?.fault).toBe("sigkill");
    // The adapter receives the exact transition context: mapped operation,
    // phase, step identity, and the invoked production result.
    expect(calls.injectFault[0]?.context).toEqual({ operation: "resume", phase: "during-task", stepId: "work", input: undefined, invoked: true, result: 4242 });
    const durability = result.trace.filter((event) => event.type === "durability");
    expect(durability).toHaveLength(1);
    const receipt = (durability[0]?.data as { receipt?: { stepId?: string; faultId?: string; productionOperation?: string; invoked?: boolean; adapter?: string; observation?: typeof observation } } | undefined)?.receipt;
    expect(receipt?.stepId).toBe("work");
    expect(receipt?.faultId).toBe("sigkill");
    expect(receipt?.productionOperation).toBe("runWorkflow");
    expect(receipt?.invoked).toBe(true);
    expect(receipt?.adapter).toBe("stub:real-process-middleware");
    expect(receipt?.observation).toEqual(observation);
    expect(result.ambiguity.map((item) => item.outcome).sort()).toEqual(["effect-applied-journal-missing", "restart-in-task"]);
  });

  test("a missing, mismatched, or non-resumed observation fails execution and never emits ambiguity", async () => {
    for (const bad of [undefined, { ...observation, resumed: false }, { ...observation, terminatedBy: "SIGTERM" }]) {
      const { adapter, calls } = makeStub(bad);
      const result = await runScenario(routingScenario(), { harness: e2eHarness({ adapter }) });
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
      expect(calls.injectFault).toHaveLength(1);
      expect(result.ambiguity).toEqual([]);
    }
  });

  test("non-occurrence: with no step there is no runWorkflow transition and the declared pair stays inert", async () => {
    const { adapter, calls } = makeStub(observation);
    const result = await runScenario(scenario("routing-inert", { steps: [], faults: [fault("sigkill", "during-task", "resume")] }), { harness: e2eHarness({ adapter }) });
    expect(result.status).toBe("finished");
    expect(calls.runStep).toEqual([]);
    expect(calls.injectFault).toEqual([]);
    expect(result.ambiguity).toEqual([]);
    expect(result.trace.some((event) => event.type === "durability")).toBe(false);
  });
});

describe("completion-cas terminal-transition middleware (unit-sim)", () => {
  type Receipt = Readonly<{ before?: string; attempted?: string; winner?: string; after?: string; stepId?: string; faultId?: string }>;
  const durabilityEvents = (result: Awaited<ReturnType<typeof runScenario>>) =>
    result.trace.filter((event) => event.type === "durability").map((event) => event.data as { operation?: string; phase?: string; receipt?: Receipt; state?: string });
  const completionEvents = (result: Awaited<ReturnType<typeof runScenario>>) =>
    durabilityEvents(result).filter((data) => data.operation === "completion-cas" || data.operation === "completion-journal-write" || data.operation === "completion-ack");

  test("occurrence: completion-cas:before-task fires at the terminal transition of a completed plain callback", async () => {
    const result = await runScenario(scenario("cc-plain-before", { steps: [step("work", { runnerBinding: "test:cc-plain-before:v1", run: () => "done" })], faults: [fault("probe", "before-task", "completion-cas")] }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const receipt = completionEvents(result).find((data) => data.operation === "completion-cas" && data.phase === "before-task")?.receipt;
    // The typed transition receipt: observed before state, attempted
    // transition, winner, after state — the CAS never committed.
    expect(receipt).toMatchObject({ before: "task-completed", attempted: "completion-cas", winner: "fault", after: "not-committed", stepId: "work", faultId: "probe" });
    expect(completionEvents(result).some((data) => data.operation === "completion-journal-write")).toBe(false);
  });

  test("occurrence: completion-cas:after-journal-before-ack fires on a COMPLETED PLAIN callback between the terminal journal write and its ack", async () => {
    // Sol's probe: a direct plain-runner scenario previously finished with no
    // fault, durability event, or ambiguity because the pair only fired
    // inside the mediated-effect journal.
    const result = await runScenario(scenario("cc-plain-ack", { steps: [step("work", { runnerBinding: "test:cc-plain-ack:v1", run: () => "done" })], faults: [fault("probe", "after-journal-before-ack", "completion-cas")] }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const events = completionEvents(result);
    const journalIndex = events.findIndex((data) => data.operation === "completion-journal-write");
    const receiptIndex = events.findIndex((data) => data.operation === "completion-cas" && data.phase === "after-journal-before-ack");
    expect(journalIndex).toBeGreaterThanOrEqual(0);
    expect(receiptIndex).toBeGreaterThan(journalIndex);
    expect(events[journalIndex]?.state).toBe("journaled");
    expect(events[receiptIndex]?.receipt).toMatchObject({ before: "completion-journaled", attempted: "ack", winner: "fault", after: "journaled-unacked", stepId: "work", faultId: "probe" });
    expect(events.some((data) => data.operation === "completion-ack")).toBe(false);
    const ambiguityItem = result.ambiguity.find((item) => item.outcome === "journal-applied-ack-missing");
    expect(ambiguityItem).toBeDefined();
    expect((ambiguityItem?.details as { transition?: string; journalState?: string } | undefined)?.transition).toBe("completion-journal-applied->ack-missing");
    expect((ambiguityItem?.details as { journalState?: string } | undefined)?.journalState).toBe("journaled");
  });

  test("occurrence: completion-cas:after-task fires only after the terminal journal AND ack applied", async () => {
    const result = await runScenario(scenario("cc-plain-after", { steps: [step("work", { runnerBinding: "test:cc-plain-after:v1", run: () => "done" })], faults: [fault("probe", "after-task", "completion-cas")] }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const events = completionEvents(result);
    const ackIndex = events.findIndex((data) => data.operation === "completion-ack");
    const receiptIndex = events.findIndex((data) => data.operation === "completion-cas" && data.phase === "after-task");
    expect(events.findIndex((data) => data.operation === "completion-journal-write")).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(receiptIndex).toBeGreaterThan(ackIndex);
    expect(events[ackIndex]?.state).toBe("acked");
    expect(events[receiptIndex]?.receipt).toMatchObject({ before: "completion-acked", winner: "fault", after: "acked", stepId: "work", faultId: "probe" });
  });

  test("non-occurrence: a callback that fails never reaches the terminal transition and stays inert", async () => {
    const result = await runScenario(scenario("cc-callback-fails", {
      steps: [step("work", { runnerBinding: "test:cc-callback-fails:v1", run: () => { throw Object.assign(new Error("callback exploded"), { code: "CALLBACK_BOOM" }); } })],
      faults: [fault("probe", "after-journal-before-ack", "completion-cas")],
    }));
    expect(result.status).toBe("failed");
    // The failure is the CALLBACK's, never the declared completion fault.
    expect(result.error?.code).toBe("CALLBACK_BOOM");
    expect(result.ambiguity).toEqual([]);
    expect(completionEvents(result)).toEqual([]);
  });

  test("non-occurrence: a runner-less no-op step commits no terminal completion", async () => {
    for (const phase of ["before-task", "after-journal-before-ack", "after-task"] as const) {
      const result = await runScenario(scenario(`cc-noop-${phase}`, { steps: [step("noop")], faults: [fault("probe", phase, "completion-cas")] }));
      expect({ phase, status: result.status, code: result.error?.code }).toEqual({ phase, status: "finished", code: undefined });
      expect({ phase, ambiguity: result.ambiguity }).toEqual({ phase, ambiguity: [] });
      expect({ phase, events: completionEvents(result) }).toEqual({ phase, events: [] });
    }
  });

  test("no conflation: the mediated-effect journal never consumes completion-cas faults — the external effect runs first", async () => {
    // Sol's probe: with completion-cas:before-task declared, a mediated-effect
    // scenario previously failed BEFORE the external effect ran.
    let effectRan = 0;
    const before = await runScenario(scenario("cc-effect-before", {
      steps: [step("work", { runnerBinding: "test:cc-effect-before:v1", run: (runtime) => runtime.effect("write", () => { effectRan++; return "ok"; }) })],
      faults: [fault("probe", "before-task", "completion-cas")],
    }));
    expect(effectRan).toBe(1);
    expect(before.status).toBe("failed");
    expect(before.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    // The effect fully journaled AND acked before the terminal transition.
    const beforeEvents = durabilityEvents(before);
    const effectAckIndex = beforeEvents.findIndex((data) => data.operation === "ack");
    const completionReceiptIndex = beforeEvents.findIndex((data) => data.operation === "completion-cas" && data.phase === "before-task");
    expect(effectAckIndex).toBeGreaterThanOrEqual(0);
    expect(completionReceiptIndex).toBeGreaterThan(effectAckIndex);

    // With the ack-phase pair declared, the ambiguity is about the TERMINAL
    // completion journal — recorded after the mediated effect acked, from the
    // completion transition, not the effect journal.
    let ackEffectRan = 0;
    const ack = await runScenario(scenario("cc-effect-ack", {
      steps: [step("work", { runnerBinding: "test:cc-effect-ack:v1", run: (runtime) => runtime.effect("write", () => { ackEffectRan++; return "ok"; }) })],
      faults: [fault("probe", "after-journal-before-ack", "completion-cas")],
    }));
    expect(ackEffectRan).toBe(1);
    expect(ack.status).toBe("failed");
    expect(ack.error?.code).toBe("DURABILITY_FAULT_INJECTED");
    const ackEvents = durabilityEvents(ack);
    const mediatedAckIndex = ackEvents.findIndex((data) => data.operation === "ack");
    const completionJournalIndex = ackEvents.findIndex((data) => data.operation === "completion-journal-write");
    expect(mediatedAckIndex).toBeGreaterThanOrEqual(0);
    expect(completionJournalIndex).toBeGreaterThan(mediatedAckIndex);
    const ambiguityItem = ack.ambiguity.find((item) => item.outcome === "journal-applied-ack-missing");
    expect((ambiguityItem?.details as { transition?: string } | undefined)?.transition).toBe("completion-journal-applied->ack-missing");
  });
});
