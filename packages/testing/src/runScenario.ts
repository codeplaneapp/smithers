import { Effect, Fiber } from "effect";
import { replayIdentity } from "./scenario/replayIdentity.ts";
import { kernelLayer, KernelRuntimeService, makeKernel } from "./kernel/KernelRuntime.ts";
import { runAtBoundaryFork, type HarnessError } from "./kernel/boundary.ts";
import { deterministicIds } from "./internal/deterministicIds.ts";
import { unitSimHarness, type Harness } from "./harness/Harness.ts";
import type { ScenarioAst, ScenarioFault, ScenarioValue } from "./scenario/ast.ts";
import type { ControlMessage } from "./control/ControlMessage.ts";
import type { TraceEvent } from "./trace/TraceEvent.ts";
import { compileScenario } from "./scenario/compile.ts";
import { stepRunner, type TaskRuntime } from "./scenario/builder.ts";
import { CleanupScope } from "./cleanup/CleanupScope.ts";
import { assertNoLeaks } from "./cleanup/leakAssertions.ts";
import { JournalModel } from "./durability/journalModel.ts";
import { ambiguity, type AmbiguityResult } from "./durability/ambiguity.ts";

export type DeterminismReport = Readonly<{ readonly deterministic: boolean; readonly residues: readonly string[] }>;
export type ScenarioStatus = "finished" | "failed" | "capability-failure" | "capability-skip";
export type ScenarioResult = Readonly<{ readonly status: ScenarioStatus; readonly outputs: Readonly<Record<string, unknown>>; readonly trace: readonly TraceEvent[]; readonly replayIdentity: string; readonly controlLog: readonly ControlMessage[]; readonly capabilityReport: readonly unknown[]; readonly ambiguity: readonly AmbiguityResult[]; readonly determinismReport: DeterminismReport; readonly error?: HarnessError }>;
export type RunScenarioOptions = Readonly<{ readonly harness?: Harness; readonly seed?: number; readonly controlLog?: readonly ControlMessage[]; readonly capabilities?: readonly Parameters<Harness["admit"]>[0][number][]; readonly stepRunners?: Readonly<Record<string, (runtime: TaskRuntime, input: import("./scenario/ast.ts").ScenarioValue | undefined) => unknown | Promise<unknown>>>; readonly cleanupBudget?: number; readonly waitBudget?: number }>;

const faultFor = (faults: readonly ScenarioFault[], operation: ScenarioFault["operation"], phase: ScenarioFault["phase"]): ScenarioFault | undefined => faults.find((fault) => fault.operation === operation && fault.phase === phase);
const faultAt = (faults: readonly ScenarioFault[], phase: ScenarioFault["phase"]): ScenarioFault | undefined => faults.find((fault) => fault.phase === phase);
const faultError = (fault: ScenarioFault): Error => Object.assign(new Error(`fault injected at ${fault.id}`), { code: "DURABILITY_FAULT_INJECTED", details: fault, fidelity: "simulation" as const });
const ambiguityFor = (fault: ScenarioFault, step: string, effect?: string, observed = true): AmbiguityResult | undefined => {
  if (fault.operation === "event-append" && !observed) return undefined;
  const outcome = fault.phase === "after-effect-before-journal" ? "effect-applied-journal-missing" : fault.phase === "after-journal-before-ack" ? "journal-applied-ack-missing" : fault.operation === "lease" || fault.operation === "heartbeat" ? "lease-lost" : fault.operation === "cancellation" ? "cancellation-race" : fault.operation === "resume" ? "restart-in-task" : fault.operation === "event-append" ? "lost-wakeup" : fault.operation === "completion-cas" ? "duplicate-delivery" : undefined;
  return outcome ? ambiguity(outcome, { step, effect, fault: fault.id }) : undefined;
};

/** Drive a kernel promise while its VirtualClock owns all timers. */
const settleKernel = async <T>(promise: Promise<T>, kernel: ReturnType<typeof makeKernel>, budget: number): Promise<T> => {
  let done = false; let value!: T; let error: unknown;
  void promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let turn = 0; !done && turn < budget; turn++) {
    await Promise.resolve();
    if (!done && kernel.clock.pending().length) kernel.clock.advanceToNextTimer();
  }
  if (!done) throw Object.assign(new Error("BOUNDED_WAIT_EXHAUSTED: kernel did not settle"), { code: "BOUNDED_WAIT_EXHAUSTED", details: { budget } });
  if (error !== undefined) throw error;
  return value;
};

export const runScenario = async (ast: ScenarioAst, options: RunScenarioOptions = {}): Promise<ScenarioResult> => {
  const seed = options.seed ?? ast.seed ?? 0;
  const harness = options.harness ?? unitSimHarness();
  const kernel = makeKernel(seed, options.controlLog ?? []);
  const capabilityReport = harness.admitScenario(ast, options.capabilities ?? []);
  const compiled = compileScenario(ast, harness.adapter?.extensions ?? new Set());
  const knownFaults = new Set(ast.faults.map((item) => item.id));
  const invalidControl = (options.controlLog ?? []).find((control) =>
    (control.type === "inject-fault" && !knownFaults.has(control.fault)) ||
    (control.type === "release-barrier" && !ast.barriers.some((item) => item.id === control.barrier)) ||
    (control.type === "task-restart" && !ast.steps.some((item) => item.id === control.step)),
  );
  for (const decision of capabilityReport) kernel.trace.emit({ type: "capability", data: { kind: decision.kind, capability: decision.capability } });
  const base = { replayIdentity: replayIdentity({ ast, seed, controlLog: kernel.controls.log() }), controlLog: kernel.controls.log(), capabilityReport, ambiguity: [] as AmbiguityResult[], determinismReport: { deterministic: true, residues: [] } as DeterminismReport };
  const failed = capabilityReport.find((d) => d.kind === "capability-failure");
  const skipped = capabilityReport.find((d) => d.kind === "capability-skip");
  if (failed || skipped) return { ...base, status: failed ? "capability-failure" : "capability-skip", outputs: {}, trace: kernel.trace.snapshot() };
  if (invalidControl) return { ...base, status: "failed", outputs: {}, trace: kernel.trace.snapshot(), error: { name: "ControlError", code: "CONTROL_INVALID", message: `control ${invalidControl.type} is not applicable to this scenario`, details: invalidControl, fidelity: "simulation" } };
  if (!compiled.ok) return { ...base, status: "failed", outputs: {}, trace: kernel.trace.snapshot(), error: { name: "ScenarioCompileError", code: "SCENARIO_INVALID", message: compiled.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "), details: compiled.diagnostics, fidelity: "simulation" } };
  if (harness.kind !== "unit-sim" && !harness.adapter) return { ...base, status: "capability-failure", outputs: {}, trace: kernel.trace.snapshot(), capabilityReport: [...capabilityReport, { kind: "capability-failure", harness: harness.name, capability: harness.kind === "e2e-real-process" ? "real-process" : "real-db", hint: "declaration is not proof: an executable adapter is required" }] };
  if (harness.kind !== "unit-sim" && harness.adapter) {
    const unsupported = ast.faults.filter((candidate) => !harness.adapter?.supportedCutPoints?.has(`${candidate.operation}:${candidate.phase}`));
    if (unsupported.length) {
      const error = { name: "HarnessCapabilityError", code: "ADMISSION_FAILED", message: `real harness cannot execute requested cut point(s): ${unsupported.map((item) => `${item.operation}:${item.phase}`).join(", ")}`, details: { unsupported }, fidelity: "native" as const };
      const decision = { kind: harness.config.policy === "skip" ? "capability-skip" as const : "capability-failure" as const, harness: harness.name, capability: "durability-faults" as const, hint: error.message };
      return { ...base, status: decision.kind === "capability-skip" ? "capability-skip" : "capability-failure", outputs: {}, trace: kernel.trace.snapshot(), capabilityReport: [...capabilityReport, decision], error };
    }
  }

  const outputs: Record<string, unknown> = {}; const completed = new Set<string>(); const releasedBarriers = new Set<string>(); const cleanup = new CleanupScope(); const journal = new JournalModel(); const ambiguities: AmbiguityResult[] = []; const residues = new Set<string>(); const ids = deterministicIds(seed);
  const recordAmbiguity = (item: AmbiguityResult, id: string) => { ambiguities.push(item); kernel.trace.emit({ type: "ambiguity", id, data: { outcome: item.outcome, details: item.details } as unknown as ScenarioValue }); };

  const program = Effect.gen(function* () {
    if (harness.adapter) {
      cleanup.register("harness", harness.name, harness.adapter.cleanup ?? (() => undefined));
      try { yield* Effect.tryPromise({ try: () => Promise.resolve(harness.adapter!.admissionProbe()), catch: (cause) => Object.assign(new Error(`ADMISSION_FAILED: ${harness.name} did not admit its production system`), { code: "ADMISSION_FAILED", cause, details: { native: harness.adapter?.serializeError?.(cause) } }) }); }
      catch (cause) { throw cause; }
    }
    const runtimeKernel = yield* KernelRuntimeService;
    let controlIndex = 0;
    const supplied = kernel.controls.log();
    while (controlIndex < supplied.length) {
      const control = supplied[controlIndex]!;
      if (control.type !== "advance-clock") break;
      controlIndex += 1;
      kernel.controls.takeNext("advance-clock");
      kernel.clock.advance(control.ms);
    }
    while (completed.size < ast.steps.length) {
      for (const barrier of ast.barriers) {
        const partiesComplete = barrier.parties.every((party) => completed.has(party));
        const release = partiesComplete && runtimeKernel.controls.peek()?.type === "release-barrier" ? runtimeKernel.controls.takeNext("release-barrier") : undefined;
        const released = release?.barrier === barrier.id;
        if (released) releasedBarriers.add(barrier.id);
        if (partiesComplete && !released && !releasedBarriers.has(barrier.id)) throw Object.assign(new Error(`barrier ${barrier.id} timed out waiting for release`), { code: "BARRIER_TIMEOUT", details: { barrier: barrier.id, budget: barrier.budget } });
      }
      const ready = ast.steps.filter((s) => !completed.has(s.id) && s.dependsOn.every((d) => completed.has(d)));
      if (!ready.length) throw Object.assign(new Error("no runnable steps remain"), { code: "SCENARIO_DEPENDENCY_UNSATISFIED" });
      const ordered: typeof ready = []; const remaining = [...ready];
      let pinIndex = 0;
      while (remaining.length) { const pin = runtimeKernel.controls.takeNext("pin-interleaving"); const validPin = pin && remaining.some((s) => s.id === pin.choice) ? pin : undefined; const chosen = runtimeKernel.scheduler.choose(remaining, validPin ? remaining.findIndex((s) => s.id === validPin.choice) : undefined); ordered.push(chosen); remaining.splice(remaining.indexOf(chosen), 1); if (!validPin) runtimeKernel.controls.append({ type: "pin-interleaving", choice: chosen.id }); runtimeKernel.trace.emit({ type: "schedule", id: ids.next(chosen.id), data: { step: chosen.id, ready: ready.map((s) => s.id), choice: chosen.id } }); }
      const tasks = ordered.map((selected) => Effect.gen(function* () {
        const id = ids.next(selected.id); let observedWait = false; kernel.trace.emit({ type: "task", id, data: { state: "started", step: selected.id } });
        const owner = `sim:${seed}`; journal.claimLease(selected.id, owner);
        let controlledFault: ScenarioFault | undefined;
        const runtime: TaskRuntime = {
          effect: <T>(name: string, operation: () => T | Promise<T>) => { const effectId = `${selected.id}:${name}`; const control = runtimeKernel.controls.takeResolve(effectId) ?? runtimeKernel.controls.takeResolve(name); if (control?.outcome === "fail") return Promise.reject(Object.assign(new Error(`effect ${name} failed by control`), { code: "CONTROLLED_EFFECT_FAILURE", details: control })); if (control?.outcome === "hang") return new Promise<T>(() => undefined); const beforeEffect = faultFor(ast.faults, "effect", "before-task"); if (beforeEffect) { const item = ambiguityFor(beforeEffect, selected.id, name); if (item) recordAmbiguity(item, id); return Promise.reject(faultError(beforeEffect)); } const invoke: () => Promise<T> = () => settleKernel(Promise.resolve().then(operation), kernel, options.waitBudget ?? 10_000); const run = control?.outcome === "duplicate" ? invoke().then(() => invoke()) : invoke(); return run.then((value) => { const effectId = `${selected.id}:${name}`; kernel.trace.emit({ type: "effect", id, data: { name, state: "requested" } }); const duringEffect = faultFor(ast.faults, "effect", "during-task"); if (duringEffect) { const item = ambiguityFor(duringEffect, selected.id, name); if (item) recordAmbiguity(item, id); throw faultError(duringEffect); } journal.assertLease(selected.id, owner); journal.effectApplied(effectId); const effectFault = (controlledFault?.operation === "effect" && controlledFault.phase === "after-effect-before-journal" ? controlledFault : undefined) ?? faultFor(ast.faults, "effect", "after-effect-before-journal"); if (effectFault) { const item = ambiguityFor(effectFault, selected.id, name); if (item) recordAmbiguity(item, id); throw faultError(effectFault); } journal.journal(effectId); const ackFault = (controlledFault?.phase === "after-journal-before-ack" ? controlledFault : undefined) ?? faultFor(ast.faults, "effect", "after-journal-before-ack") ?? faultFor(ast.faults, "attempt-write", "after-journal-before-ack") ?? faultFor(ast.faults, "completion-cas", "after-journal-before-ack"); if (ackFault) { const item = ambiguityFor(ackFault, selected.id, name); if (item) recordAmbiguity(item, id); throw faultError(ackFault); } journal.ack(effectId); const afterAck = (controlledFault?.phase === "after-ack" ? controlledFault : undefined) ?? faultFor(ast.faults, "effect", "after-ack") ?? faultAt(ast.faults, "after-ack"); if (afterAck) { const item = ambiguityFor(afterAck, selected.id, name); if (item) recordAmbiguity(item, id); throw faultError(afterAck); } kernel.trace.emit({ type: "effect", id, data: { name, state: "resolved" } }); return value; }); },
          sleep: (ms: number) => new Promise<void>((resolve, reject) => { observedWait = true; const wakeup = `${selected.id}:timer:${ms}`; journal.registerWakeup(wakeup); const lost = ast.faults.some((candidate) => candidate.operation === "event-append" && (candidate.phase === "during-task" || candidate.phase === "after-task")); const timer = kernel.clock.sleep(ms, () => { if (lost) { journal.loseWakeup(wakeup); recordAmbiguity(ambiguity("lost-wakeup", { step: selected.id, wakeup, transition: "registered->lost" }), id); reject(Object.assign(new Error("lost wakeup"), { code: "LOST_WAKEUP" })); return; } journal.deliverWakeup(wakeup); kernel.trace.emit({ type: "wait", id, data: { state: "timer-fired", ms } }); resolve(); }); cleanup.register("virtual-timer", String(timer), () => kernel.clock.cancel(timer)); }),
          log: (message: string, data?: ScenarioValue) => kernel.trace.emit({ type: "task", id, data: { state: "log", message, ...(data === undefined ? {} : { data }) } }),
          opaque: <T>(name: string, operation: () => T | Promise<T>) => { kernel.trace.emit({ type: "opaque-effect", id, data: { name, controllable: false } }); return Promise.resolve().then(operation); },
        };
        if (harness.adapter?.runStep && harness.kind !== "unit-sim") {
          const productionOperation = harness.kind === "e2e-real-process" ? "runWorkflow" : selected.id;
          yield* Effect.tryPromise({ try: () => Promise.resolve(harness.adapter!.runStep!(productionOperation, selected.id, selected.input)), catch: (e) => e });
          kernel.trace.emit({ type: "adapter", id, data: { identity: harness.adapter.identity, step: selected.id, executed: true } });
        }
        if (runtimeKernel.controls.peek()?.type === "inject-fault") {
          const control = runtimeKernel.controls.takeNext("inject-fault")!;
          controlledFault = ast.faults.find((candidate) => candidate.id === control.fault);
          kernel.trace.emit({ type: "fault", id: control.fault, data: control.payload });
        }
        const extensionExecutor = selected.extension ? harness.adapter?.extensionExecutors?.[selected.extension] : undefined;
        if (selected.extension && extensionExecutor) yield* Effect.tryPromise({ try: () => Promise.resolve(extensionExecutor(selected.id, selected.input)), catch: (e) => e });
        // During-task controls rendezvous after user code has entered. This
        // keeps a declared ambiguity from becoming a pre-execution shortcut.
        const duringTransition = undefined;
        const injectable = ast.faults.find((candidate) => candidate.phase === "before-task" && candidate.operation === "task");
        const injectFault = harness.adapter?.injectFault;
        if (injectable && injectFault && harness.kind !== "unit-sim") yield* Effect.tryPromise({ try: () => Promise.resolve(injectFault(injectable)), catch: (e) => e });
        const before = (controlledFault?.phase === "before-task" ? controlledFault : undefined) ?? faultFor(ast.faults, "task", "before-task") ?? faultFor(ast.faults, "resume", "before-task") ?? faultAt(ast.faults, "before-task");
        if (before) { const item = ambiguityFor(before, selected.id); if (item) recordAmbiguity(item, id); throw faultError(before); }
        // Interruption/fault controls are rendezvous points before user code
        // starts. Applying them here makes cancellation and during-task faults
        // observable before a callback can finish synchronously.
        if (runtimeKernel.controls.peek()?.type === "cancel") {
          const cancel = runtimeKernel.controls.takeNext("cancel")!;
          recordAmbiguity(ambiguity("cancellation-race", { step: selected.id, reason: cancel.reason ?? "cancelled", transition: "task-started->cancelled" }), id);
          throw Object.assign(new Error(cancel.reason ?? "scenario cancelled"), { code: "SCENARIO_CANCELLED" });
        }
        if (controlledFault?.phase === "during-task") { if (controlledFault.operation === "lease" || controlledFault.operation === "heartbeat" || controlledFault.operation === "cancellation") journal.loseLease(selected.id); const item = ambiguityFor(controlledFault, selected.id); if (item) recordAmbiguity(item, id); throw faultError(controlledFault); }
        // Lease, heartbeat, cancellation, and resume faults rendezvous after
        // the callback below, where a real task transition has occurred.
        const runner = options.stepRunners?.[selected.id] ?? stepRunner(selected);
        // The kernel cannot inspect arbitrary user code. A callback is therefore
        // opaque unless it explicitly crosses taskRuntime.effect.
        if (runner) kernel.trace.emit({ type: "opaque-effect", id, data: { name: `step:${selected.id}`, controllable: false } });
        let value: unknown;
        const duringFault = ast.faults.find((candidate) => candidate.phase === "during-task");
        if (runner && duringFault) {
          if (injectFault && harness.kind !== "unit-sim") yield* Effect.tryPromise({ try: () => Promise.resolve(injectFault(duringFault)), catch: (e) => e });
          if (duringFault.operation === "resume") {
            // The first attempt reaches the cut point and its externally
            // visible work may already have happened before the crash.
            value = yield* Effect.tryPromise({ try: () => Promise.resolve(runner(runtime, selected.input)), catch: (e) => e });
            const item = ambiguityFor(duringFault, selected.id); if (item) recordAmbiguity(item, id);
            value = yield* Effect.tryPromise({ try: () => Promise.resolve(runner(runtime, selected.input)), catch: (e) => e });
          } else {
          const child = yield* Effect.fork(Effect.tryPromise({ try: () => Promise.resolve(runner(runtime, selected.input)), catch: (e) => e }));
          yield* Fiber.interrupt(child);
          if (duringFault.operation === "lease" || duringFault.operation === "heartbeat" || duringFault.operation === "cancellation") journal.loseLease(selected.id);
          const item = ambiguityFor(duringFault, selected.id); if (item) recordAmbiguity(item, id);
          throw faultError(duringFault);
          }
        }
        if (runner && !duringFault) value = yield* Effect.tryPromise({ try: () => Promise.resolve(runner(runtime, selected.input)), catch: (e) => e });
        const duplicateControl = runtimeKernel.controls.find("resolve-effect").find((control) => control.outcome === "duplicate" && (control.effect === selected.id || control.effect.startsWith(`${selected.id}:`)));
        if (duplicateControl && !ambiguities.some((item) => item.details.step === selected.id && item.outcome === "duplicate-delivery")) recordAmbiguity(ambiguity("duplicate-delivery", { step: selected.id, effect: duplicateControl.effect, transition: "effect-resolved->redelivered", journalState: journal.state(duplicateControl.effect) }), id);
        if (runtimeKernel.controls.peek()?.type === "cancel") {
          const cancel = runtimeKernel.controls.takeNext("cancel")!;
          recordAmbiguity(ambiguity("cancellation-race", { step: selected.id, reason: cancel.reason ?? "cancelled", transition: "task-completed->cancelled" }), id);
          throw Object.assign(new Error(cancel.reason ?? "scenario cancelled"), { code: "SCENARIO_CANCELLED" });
        }
        const pendingControl = runtimeKernel.controls.peek();
        if (pendingControl?.type === "task-restart" && pendingControl.step === selected.id) {
          runtimeKernel.controls.takeNext("task-restart");
          recordAmbiguity(ambiguity("restart-in-task", { step: selected.id, transition: "task-completed->restarted" }), id);
          if (runner) value = yield* Effect.tryPromise({ try: () => Promise.resolve(runner(runtime, selected.input)), catch: (e) => e });
        }
        const during = faultFor(ast.faults, "task", "during-task") ?? faultFor(ast.faults, "lease", "during-task") ?? faultFor(ast.faults, "heartbeat", "during-task") ?? faultFor(ast.faults, "cancellation", "during-task") ?? faultFor(ast.faults, "event-append", "during-task") ?? faultFor(ast.faults, "resume", "during-task") ?? faultAt(ast.faults, "during-task"); if (during && during.operation !== "resume") { const item = ambiguityFor(during, selected.id, undefined, observedWait); if (item) recordAmbiguity(item, id); throw faultError(during); }
        const after = (controlledFault?.phase === "after-task" ? controlledFault : undefined) ?? faultFor(ast.faults, "task", "after-task") ?? faultFor(ast.faults, "completion-cas", "after-task") ?? faultFor(ast.faults, "event-append", "after-task") ?? faultAt(ast.faults, "after-task");
        if (after) { const item = ambiguityFor(after, selected.id); if (item) recordAmbiguity(item, id); throw faultError(after); }
        kernel.trace.emit({ type: "task", id, data: { state: "finished", step: selected.id } }); return value;
      }));
      // Settle one selected task at a time. This still exposes the complete
      // ready set to the seeded scheduler, while making a newly-ready
      // dependent runnable immediately after its predecessor settles.
      for (let index = 0; index < tasks.length; index += 1) {
        const value = yield* tasks[index]!;
        const selected = ordered[index]!;
        outputs[selected.id] = value;
        completed.add(selected.id);
      }
    }
    for (const item of ast.barriers) { const pendingRelease = kernel.controls.peek(); const release = pendingRelease?.type === "release-barrier" && pendingRelease.barrier === item.id ? kernel.controls.takeNext("release-barrier") : undefined; const released = release?.barrier === item.id || releasedBarriers.has(item.id); if (!released) throw Object.assign(new Error(`barrier ${item.id} timed out waiting for release`), { code: "BARRIER_TIMEOUT", details: { barrier: item.id, budget: item.budget } }); kernel.trace.emit({ type: "barrier", id: item.id, data: { state: "released", parties: item.parties } }); }
    return outputs;
  });
  const execution = runAtBoundaryFork(program.pipe(Effect.provide(kernelLayer(kernel))));
  let result: Awaited<typeof execution.promise>;
  try { result = await settleKernel(execution.promise, kernel, options.waitBudget ?? 10_000); } catch (cause) { await execution.interrupt(); result = { ok: false, error: { name: "BoundedWaitError", code: "BOUNDED_WAIT_EXHAUSTED", message: String(cause) } }; }
  let cleanupFailure: unknown;
  try { await cleanup.close(options.cleanupBudget ?? 100); } catch (cause) { cleanupFailure = cause; }
  try { assertNoLeaks(cleanup, kernel.clock.pending().map((timer) => ({ kind: "virtual-timer", id: String(timer.id) }))); } catch (cause) { cleanupFailure ??= cause; }
  if (cleanupFailure) {
    const primary = result.ok ? undefined : result.error;
    result = { ok: false, error: { name: "CleanupError", code: "CLEANUP_FAILED", message: String((cleanupFailure as Error).message), details: { cleanup: cleanupFailure, ...(primary ? { primary } : {}) }, ...(primary ? { cause: primary } : {}) } };
  }
  if (kernel.trace.snapshot().some((event) => event.type === "opaque-effect")) residues.add("unmediated-opaque-effect");
  const finalControlLog = kernel.controls.log();
  const finalBase = { ...base, controlLog: finalControlLog, replayIdentity: replayIdentity({ ast, seed, controlLog: finalControlLog }), ambiguity: ambiguities, determinismReport: { deterministic: residues.size === 0, residues: [...residues] } };
  if (!result.ok && result.error.code === "ADMISSION_FAILED") {
    const kind = harness.kind === "e2e-real-process" ? "real-process" : "real-db";
    const skippedAdmission = harness.config.policy === "skip";
    return { ...finalBase, status: skippedAdmission ? "capability-skip" : "capability-failure", outputs, trace: kernel.trace.snapshot(), capabilityReport: [...capabilityReport, { kind: skippedAdmission ? "capability-skip" : "capability-failure", harness: harness.name, capability: kind, hint: result.error.message }], error: result.error };
  }
  return result.ok ? { ...finalBase, status: "finished", outputs: result.value, trace: kernel.trace.snapshot() } : { ...finalBase, status: "failed", outputs, trace: kernel.trace.snapshot(), error: result.error };
};
