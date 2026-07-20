import { Effect, Fiber, Option } from "effect";
import { replayIdentity } from "./scenario/replayIdentity.ts";
import { kernelLayer, KernelRuntimeService, makeKernel } from "./kernel/KernelRuntime.ts";
import { runAtBoundaryFork, type HarnessError } from "./kernel/boundary.ts";
import { deterministicIds } from "./internal/deterministicIds.ts";
import { unitSimHarness, type Harness } from "./harness/Harness.ts";
import type { ScenarioAst, ScenarioFault, ScenarioValue } from "./scenario/ast.ts";
import type { ControlMessage } from "./control/ControlMessage.ts";
import type { TraceEvent } from "./trace/TraceEvent.ts";
import { compileScenario } from "./scenario/compile.ts";
import { stepRunner, validRunnerBinding, type TaskRuntime } from "./scenario/builder.ts";
import { CleanupScope } from "./cleanup/CleanupScope.ts";
import { assertNoLeaks } from "./cleanup/leakAssertions.ts";
import { JournalModel } from "./durability/journalModel.ts";
import { ambiguity, type AmbiguityResult } from "./durability/ambiguity.ts";
import { canonicalize } from "./scenario/canonicalize.ts";

export type DeterminismReport = Readonly<{ readonly deterministic: boolean; readonly residues: readonly string[] }>;
export type ScenarioStatus = "finished" | "failed" | "capability-failure" | "capability-skip";
export type ScenarioResult = Readonly<{ readonly status: ScenarioStatus; readonly outputs: Readonly<Record<string, unknown>>; readonly trace: readonly TraceEvent[]; readonly replayIdentity: string; readonly controlLog: readonly ControlMessage[]; readonly capabilityReport: readonly unknown[]; readonly ambiguity: readonly AmbiguityResult[]; readonly determinismReport: DeterminismReport; readonly error?: HarnessError }>;
export type RunScenarioOptions = Readonly<{ readonly harness?: Harness; readonly seed?: number; readonly controlLog?: readonly ControlMessage[]; readonly capabilities?: readonly Parameters<Harness["admit"]>[0][number][]; readonly stepRunners?: Readonly<Record<string, (runtime: TaskRuntime, input: import("./scenario/ast.ts").ScenarioValue | undefined) => unknown | Promise<unknown>>>; readonly cleanupBudget?: number; readonly waitBudget?: number }>;

const faultFor = (faults: readonly ScenarioFault[], operation: ScenarioFault["operation"], phase: ScenarioFault["phase"]): ScenarioFault | undefined => faults.find((fault) => fault.operation === operation && fault.phase === phase);
/**
 * Map a production adapter operation name onto the framework's durability
 * vocabulary. Real-harness cut points fire ONLY around these transitions: a
 * cut point whose operation never transitions is a non-occurrence, never a
 * simulated stand-in.
 */
const dbOperationKind = (name: string): ScenarioFault["operation"] | undefined => {
  const base = name.replace(/#\d+$/, "");
  if (base === "claimAttemptCompletion" || base === "completeRun") return "completion-cas";
  if (base === "claimRunForResume") return "resume";
  if (base === "heartbeatRun" || base === "heartbeatAttempt") return "heartbeat";
  if (base === "requestRunCancel" || base === "claimRunCancellation") return "cancellation";
  return undefined;
};
/**
 * The real-process adapter's only production transition is the runWorkflow
 * child; its during-task cut point IS the adapter-owned SIGKILL plus the
 * verified fresh-process resume, observed from durable state.
 */
const processOperationKind = (name: string): ScenarioFault["operation"] | undefined =>
  name.replace(/#\d+$/, "") === "runWorkflow" ? "resume" : undefined;
/** The observation a real-process adapter returns from its resume:during-task transition. */
type RealProcessTransitionObservation = Readonly<{ terminatedBy?: string; preKillEffectApplied?: boolean; journalWritten?: boolean; outputPersisted?: boolean; resumed?: boolean; resumedStatus?: string; resumedOutputPersisted?: boolean }>;
const faultError = (fault: ScenarioFault): Error => Object.assign(new Error(`fault injected at ${fault.id}`), { code: "DURABILITY_FAULT_INJECTED", details: fault, fidelity: "simulation" as const });
const adapterFailure = (adapter: Harness["adapter"], cause: unknown): unknown => {
  if (!adapter) return cause;
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return Object.assign(error, {
    fidelity: "native" as const,
    ...(adapter.serializeError ? { serialized: adapter.serializeError(cause) } : {}),
  });
};

/** Drive a kernel promise while its VirtualClock owns all timers. */
const settleKernel = async <T>(promise: Promise<T>, kernel: ReturnType<typeof makeKernel>, budget: number): Promise<T> => {
  let done = false; let value!: T; let error: unknown;
  void promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let turn = 0; !done && turn < budget; turn++) {
    // Let the Effect scheduler drain its ready queue before advancing virtual
    // time; otherwise a timer in a sibling fiber can win merely because the
    // host loop advanced the clock before a just-completed fiber resumed.
    // Drain the Effect scheduler to a stable point before deciding that the
    // virtual kernel is quiescent. Four turns is not a scheduler contract:
    // user continuations may legally cross many host microtasks. The caller's
    // bounded-wait budget is the guard; virtual time is advanced only after
    // this bounded quiescence pass.
    for (let microtask = 0; microtask < Math.min(64, Math.max(1, budget)); microtask++) await Promise.resolve();
    if (!done) {
      const advance = kernel.controls.takeAdvanceClock();
      if (advance) kernel.clock.advance(advance.ms);
      else if (kernel.clock.pending().length) kernel.clock.advanceToNextTimer();
    }
  }
  if (!done) throw Object.assign(new Error("BOUNDED_WAIT_EXHAUSTED: kernel did not settle"), { code: "BOUNDED_WAIT_EXHAUSTED", details: { budget } });
  if (error !== undefined) throw error;
  return value;
};

export const runScenario = async (ast: ScenarioAst, options: RunScenarioOptions = {}): Promise<ScenarioResult> => {
  const seed = options.seed ?? ast.seed ?? 0;
  const harness = options.harness ?? unitSimHarness();
  const kernel = makeKernel(seed, options.controlLog ?? []);
  // An executable is input, not scenario data, HOWEVER it reaches the run —
  // out-of-band through options.stepRunners or attached by the builder's
  // registry. Either way it must be named by a VALID canonical binding before
  // it can participate in a replay: without this admission check two
  // different callbacks can share the same AST and replay identity while
  // producing different outputs. Validity, not mere presence, is the test —
  // Sol's round-9 counterexample rode an empty-string binding through every
  // truthiness check while the builder registry still held its executable.
  const unboundRunner = ast.steps.filter((step) => (options.stepRunners?.[step.id] !== undefined || stepRunner(step) !== undefined) && !validRunnerBinding(step.runnerBinding)).map((step) => step.id);
  // An AST is plain data, so a hand-crafted step can carry a binding the
  // builder would have rejected. A present-but-invalid binding (empty,
  // whitespace-only, non-string) is malformed identity even with no runner
  // in sight: it cannot canonicalize to one behavior, so it never executes.
  const invalidBinding = ast.steps.filter((step) => step.runnerBinding !== undefined && !validRunnerBinding(step.runnerBinding)).map((step) => step.id);
  // The `anonymous:` namespace is retired framework-issued identity. The
  // builder never mints it and rejects caller-supplied claims, but an AST is
  // plain data — a hand-crafted step could still carry an `anonymous:` binding
  // and pair it with an out-of-band runner, reviving a content-addressed
  // identity the framework can no longer vouch for. Reject it at admission.
  const retiredBinding = ast.steps.filter((step) => typeof step.runnerBinding === "string" && step.runnerBinding.startsWith("anonymous:")).map((step) => step.id);
  const capabilityReport = harness.admitScenario(ast, options.capabilities ?? []);
  // An extension declaration is not an executor. Compile against the
  // executable registry so a registered-name-without-implementation cannot
  // become a silent no-op.
  const compiled = compileScenario(ast, new Set(Object.keys(harness.adapter?.extensionExecutors ?? {})));
  const knownFaults = new Set(ast.faults.map((item) => item.id));
  const invalidControl = (options.controlLog ?? []).find((control) =>
    (control.type === "inject-fault" && !knownFaults.has(control.fault)) ||
    (control.type === "release-barrier" && !ast.barriers.some((item) => item.id === control.barrier)) ||
    (control.type === "task-restart" && !ast.steps.some((item) => item.id === control.step)),
  );
  for (const decision of capabilityReport) kernel.trace.emit({ type: "capability", data: { kind: decision.kind, capability: decision.capability } });
  const replayControls = options.controlLog ?? [];
  const base = { replayIdentity: replayIdentity({ ast, seed, controlLog: replayControls }), controlLog: kernel.controls.log(), capabilityReport, ambiguity: [] as AmbiguityResult[], determinismReport: { deterministic: true, residues: [] } as DeterminismReport };
  if (unboundRunner.length) return { ...base, status: "failed", outputs: {}, trace: kernel.trace.snapshot(), error: { name: "ReplayIdentityError", code: "RUNNER_BINDING_REQUIRED", message: `step runner(s) require explicit stable runnerBinding: ${unboundRunner.join(", ")}`, details: { steps: unboundRunner }, fidelity: "simulation" } };
  if (invalidBinding.length) return { ...base, status: "failed", outputs: {}, trace: kernel.trace.snapshot(), error: { name: "ReplayIdentityError", code: "RUNNER_BINDING_INVALID", message: `runnerBinding must be a non-empty stable string: ${invalidBinding.join(", ")}`, details: { steps: invalidBinding }, fidelity: "simulation" } };
  if (retiredBinding.length) return { ...base, status: "failed", outputs: {}, trace: kernel.trace.snapshot(), error: { name: "ReplayIdentityError", code: "RUNNER_BINDING_CONFLICT", message: `the anonymous: binding namespace is retired framework-issued identity and cannot execute: ${retiredBinding.join(", ")}`, details: { steps: retiredBinding }, fidelity: "simulation" } };
  const failed = capabilityReport.find((d) => d.kind === "capability-failure");
  const skipped = capabilityReport.find((d) => d.kind === "capability-skip");
  if (failed || skipped) return { ...base, status: failed ? "capability-failure" : "capability-skip", outputs: {}, trace: kernel.trace.snapshot(), ...(failed && harness.kind !== "unit-sim" ? { error: { name: "HarnessCapabilityError", code: "ADMISSION_FAILED", message: failed.hint ?? "real harness admission failed", details: failed, fidelity: "native" as const } } : {}) };
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

  const outputs: Record<string, unknown> = {}; const parkedValues = new Map<string, unknown>(); const completed = new Set<string>(); const parked = new Set<string>(); const releasedBarriers = new Set<string>(); const cleanup = new CleanupScope(); const journal = new JournalModel(); const ambiguities: AmbiguityResult[] = []; const residues = new Set<string>(); const ids = deterministicIds(seed);
  const recordAmbiguity = (item: AmbiguityResult, id: string) => { ambiguities.push(item); kernel.trace.emit({ type: "ambiguity", id, data: { outcome: item.outcome, details: item.details } as unknown as ScenarioValue }); };

  const program = Effect.gen(function* () {
    if (harness.adapter) {
      cleanup.register("harness", harness.name, harness.adapter.cleanup ?? (() => undefined));
      // Admission is an executable resource acquisition.  Run it exactly once
      // inside the kernel so the resource that was proven is the resource that
      // cleanup later releases; a second probe can otherwise leak the first DB
      // handle or child process and make the proof observer-dependent.
      yield* Effect.tryPromise({ try: () => Promise.resolve(harness.adapter!.admissionProbe()), catch: (cause) => Object.assign(new Error(`ADMISSION_FAILED: ${harness.name} did not admit its production system`), { code: "ADMISSION_FAILED", cause, details: { native: harness.adapter?.serializeError?.(cause) } }) });
      for (const extension of ast.extensions) {
        const executor = harness.adapter.extensionExecutors?.[extension.name];
        if (!executor) throw Object.assign(new Error(`UNREGISTERED_EXTENSION: ${extension.name}`), { code: "UNREGISTERED_EXTENSION", details: { extension: extension.name } });
        yield* Effect.tryPromise({ try: () => Promise.resolve(executor(extension.name, extension.value)), catch: (cause) => adapterFailure(harness.adapter, cause) });
        kernel.trace.emit({ type: "adapter", id: extension.name, data: { identity: harness.adapter.identity, extension: extension.name, executed: true } });
      }
    }
    const runtimeKernel = yield* KernelRuntimeService;
    const activeTaskIds = new Set<string>();
    const barrierGates = new Map<string, { readonly arrived: Set<string>; readonly promise: Promise<void>; readonly release: () => void }>();
    const barrierGate = (barrierId: string) => {
      const existing = barrierGates.get(barrierId);
      if (existing) return existing;
      let release!: () => void;
      const gate = { arrived: new Set<string>(), promise: new Promise<void>((resolve) => { release = resolve; }), release };
      barrierGates.set(barrierId, gate);
      return gate;
    };
    const applyCutPoint = (operation: ScenarioFault["operation"], phase: ScenarioFault["phase"], stepId: string): void => {
      const candidate = ast.faults.find((item) => item.operation === operation && item.phase === phase);
      if (!candidate) return;
      const receipt = { before: "runnable", attempted: `${operation}:${phase}`, winner: "fault", after: "failed", stepId, faultId: candidate.id };
      kernel.trace.emit({ type: "durability", id: ids.next(`${operation}:${phase}`), data: { operation, phase, receipt } as unknown as ScenarioValue });
      throw faultError(candidate);
    };
    // completion-cas is the simulated TERMINAL completion transition: ONE
    // middleware around the completion CAS commit and its journal/ack receipt.
    // It is invoked only where a task with a runner actually reaches terminal
    // completion; the mediated-effect journal above never stands in for it,
    // and real harnesses observe completion-cas only at the adapter
    // transition middleware.
    const simulatedCompletionTransition = (stepId: string, taskId: string): void => {
      if (harness.kind !== "unit-sim") return;
      if (!ast.faults.some((candidate) => candidate.operation === "completion-cas")) return;
      const completionKey = `${stepId}:completion`;
      const emitReceipt = (phase: ScenarioFault["phase"], receipt: Record<string, unknown>) =>
        kernel.trace.emit({ type: "durability", id: ids.next(`completion-cas:${phase}`), data: { operation: "completion-cas", phase, receipt } as unknown as ScenarioValue });
      const before = faultFor(ast.faults, "completion-cas", "before-task");
      if (before) {
        emitReceipt("before-task", { before: "task-completed", attempted: "completion-cas", winner: "fault", after: "not-committed", stepId, faultId: before.id, journalState: journal.state(completionKey) });
        throw faultError(before);
      }
      // The CAS commits: the terminal completion row is journaled durably.
      if (!journal.journal(completionKey)) throw Object.assign(new Error(`duplicate completion journal write ${completionKey}`), { code: "JOURNAL_DUPLICATE" });
      kernel.trace.emit({ type: "durability", id: taskId, data: { operation: "completion-journal-write", step: stepId, state: journal.state(completionKey) } });
      const ackFault = faultFor(ast.faults, "completion-cas", "after-journal-before-ack");
      if (ackFault) {
        recordAmbiguity(ambiguity("journal-applied-ack-missing", { step: stepId, before: "completion-journaled", attempted: "ack", winner: "journal-write", after: "journaled", transition: "completion-journal-applied->ack-missing", journalState: journal.state(completionKey), fault: ackFault.id }), taskId);
        emitReceipt("after-journal-before-ack", { before: "completion-journaled", attempted: "ack", winner: "fault", after: "journaled-unacked", stepId, faultId: ackFault.id, journalState: journal.state(completionKey) });
        throw faultError(ackFault);
      }
      journal.ack(completionKey);
      kernel.trace.emit({ type: "durability", id: taskId, data: { operation: "completion-ack", step: stepId, state: journal.state(completionKey) } });
      const afterCompletion = faultFor(ast.faults, "completion-cas", "after-task");
      if (afterCompletion) {
        emitReceipt("after-task", { before: "completion-acked", attempted: "post-completion", winner: "fault", after: "acked", stepId, faultId: afterCompletion.id, journalState: journal.state(completionKey) });
        throw faultError(afterCompletion);
      }
    };
    let controlIndex = 0;
    while (runtimeKernel.controls.peek()?.type === "advance-clock") runtimeKernel.clock.advance(runtimeKernel.controls.takeAdvanceClock()!.ms);
    while (completed.size < ast.steps.length) {
      for (const barrier of ast.barriers) {
        const arrived = barrier.parties.every((party) => parked.has(party));
        if (arrived && !releasedBarriers.has(barrier.id)) {
          const release = runtimeKernel.controls.peek()?.type === "release-barrier" ? runtimeKernel.controls.takeNext("release-barrier") : undefined;
          if (release?.barrier === barrier.id) {
            releasedBarriers.add(barrier.id);
            for (const party of barrier.parties) { parked.delete(party); completed.add(party); if (parkedValues.has(party)) outputs[party] = parkedValues.get(party); parkedValues.delete(party); }
            kernel.trace.emit({ type: "barrier", id: ids.next(barrier.id), data: { state: "released", parties: barrier.parties } });
          }
        }
      }
      if (completed.size === ast.steps.length) break;
      const ready = ast.steps.filter((s) => !completed.has(s.id) && !parked.has(s.id) && !activeTaskIds.has(s.id) && s.dependsOn.every((d) => completed.has(d)));
      if (!ready.length && !activeTaskIds.size) {
        const waiting = ast.barriers.find((barrier) => barrier.parties.every((party) => parked.has(party)) && !releasedBarriers.has(barrier.id));
        if (waiting) throw Object.assign(new Error(`barrier ${waiting.id} timed out waiting for release`), { code: "BARRIER_TIMEOUT", details: { barrier: waiting.id, budget: waiting.budget } });
        throw Object.assign(new Error("no runnable steps remain"), { code: "SCENARIO_DEPENDENCY_UNSATISFIED" });
      }
      if (!ready.length) {
        const winner = yield* runtimeKernel.executor.runReadySet([]);
        activeTaskIds.delete(winner.stepId);
        const winnerBarrier = ast.barriers.find((item) => item.parties.includes(winner.stepId) && !releasedBarriers.has(item.id));
        if (winnerBarrier) {
          parkedValues.set(winner.stepId, winner.value); parked.add(winner.stepId);
          kernel.trace.emit({ type: "barrier", id: ids.next(winnerBarrier.id), data: { state: "parked", step: winner.stepId, released: false } });
        } else { completed.add(winner.stepId); outputs[winner.stepId] = winner.value; }
        continue;
      }
      const ordered: typeof ready = []; const remaining = [...ready];
      while (remaining.length) { const pin = runtimeKernel.controls.takeApplicablePin(remaining.map((s) => s.id)); const chosen = runtimeKernel.scheduler.choose(remaining, pin ? remaining.findIndex((s) => s.id === pin.choice) : undefined); ordered.push(chosen); remaining.splice(remaining.indexOf(chosen), 1); if (!pin) runtimeKernel.controls.append({ type: "pin-interleaving", choice: chosen.id }); runtimeKernel.trace.emit({ type: "schedule", id: ids.next(chosen.id), data: { step: chosen.id, ready: ready.map((s) => s.id), choice: chosen.id, controlIndex: Math.max(0, runtimeKernel.controls.consumed() - 1) } }); }
      // A barrier is a continuation rendezvous, not a global scheduler gate:
      // launch every currently-ready fiber so unrelated work can progress
      // while barrier parties park at their continuation boundary.
      const executableOrdered = ordered;
      const tasks = executableOrdered.map((selected) => Effect.gen(function* () {
        const id = ids.next(selected.id); kernel.trace.emit({ type: "task", id, data: { state: "started", step: selected.id } });
        // Durability cut points are operation middleware, not aliases for
        // task entry. They are invoked below only when the corresponding
        // mediated effect, wakeup/event, or completion operation occurs.
        const owner = `sim:${seed}`; journal.claimLease(selected.id, owner);
        // An inject-fault control ARMS its declared fault at the task
        // rendezvous; only the matching operation/phase transition may fire
        // it. Every firing path except the resume restart (and a real
        // adapter's observed transition) fails the task outright, so a task
        // that COMPLETES with the armed fault unobserved proves the named
        // operation never transitioned — an unconsumed control, never a fault.
        let controlledFault: ScenarioFault | undefined;
        let controlledFaultObserved = false;
        const runtime: TaskRuntime = {
          effect: <T>(name: string, operation: () => T | Promise<T>, effectOptions?: Readonly<{ idempotencyKey?: string }>) => {
            const effectId = `${selected.id}:${name}`;
            const idempotencyKey = effectOptions?.idempotencyKey;
            const control = runtimeKernel.controls.takeResolve(effectId) ?? runtimeKernel.controls.takeResolve(name);
            if (control?.outcome === "succeed") {
              kernel.trace.emit({ type: "effect", id, data: { name, state: "resolved", controlled: true, ...(idempotencyKey ? { idempotencyKey } : {}) } });
              return Promise.resolve(control.value as T);
            }
            if (control?.outcome === "fail") return Promise.reject(Object.assign(new Error(`effect ${name} failed by control`), { code: "CONTROLLED_EFFECT_FAILURE", details: control }));
            if (control?.outcome === "hang") { const pending = new Promise<T>(() => undefined); cleanup.track({ kind: "mediated-effect", id: effectId }, pending); return pending; }
            const beforeEffect = faultFor(ast.faults, "effect", "before-task");
            if (beforeEffect) return Promise.reject(faultError(beforeEffect));
            const invoke: () => Promise<T> = () => {
              const pending = settleKernel(Promise.resolve().then(operation), kernel, options.waitBudget ?? 10_000);
              cleanup.track({ kind: "mediated-effect", id: effectId }, pending);
              return pending;
            };
            const run = control?.outcome === "duplicate" ? invoke().then(() => invoke()).then((value) => {
              recordAmbiguity(ambiguity("duplicate-delivery", { step: selected.id, effect: effectId, before: journal.state(effectId), attempted: "redelivery", winner: "duplicate-delivery", after: journal.state(effectId), transition: "effect-resolved->redelivered", journalState: journal.state(effectId) }), id);
              return value;
            }) : invoke();
            return run.then((value) => {
              kernel.trace.emit({ type: "effect", id, data: { name, state: "requested", ...(idempotencyKey ? { idempotencyKey } : {}) } });
              const duringEffect = faultFor(ast.faults, "effect", "during-task");
              if (duringEffect) throw faultError(duringEffect);
              journal.assertLease(selected.id, owner); journal.effectApplied(effectId); kernel.trace.emit({ type: "durability", id, data: { operation: "effect-applied", effect: effectId, state: journal.state(effectId) } });
              const effectFault = (controlledFault?.operation === "effect" && controlledFault.phase === "after-effect-before-journal" ? controlledFault : undefined) ?? faultFor(ast.faults, "effect", "after-effect-before-journal");
              if (effectFault) { recordAmbiguity(ambiguity("effect-applied-journal-missing", { step: selected.id, effect: effectId, before: "none", attempted: "journal-write", winner: "external-effect", after: "effect-applied", transition: "effect-applied->journal-missing", fault: effectFault.id }), id); throw faultError(effectFault); }
              applyCutPoint("attempt-write", "before-task", selected.id);
            if (!journal.journal(effectId)) throw Object.assign(new Error(`duplicate journal write ${effectId}`), { code: "JOURNAL_DUPLICATE" });
              kernel.trace.emit({ type: "durability", id, data: { operation: "journal-write", effect: effectId, state: journal.state(effectId) } });
              // The mediated effect's journal/ack never stands in for the
              // terminal completion CAS: completion-cas faults fire only at
              // the completion-transition middleware below.
              const ackFault = ((controlledFault?.operation === "effect" || controlledFault?.operation === "attempt-write") && controlledFault.phase === "after-journal-before-ack" ? controlledFault : undefined) ?? faultFor(ast.faults, "effect", "after-journal-before-ack") ?? faultFor(ast.faults, "attempt-write", "after-journal-before-ack");
              if (ackFault) { recordAmbiguity(ambiguity("journal-applied-ack-missing", { step: selected.id, effect: effectId, before: "journaled", attempted: "ack", winner: "journal-write", after: "journaled", transition: "journal-applied->ack-missing", fault: ackFault.id }), id); throw faultError(ackFault); }
              journal.ack(effectId); kernel.trace.emit({ type: "durability", id, data: { operation: "ack", effect: effectId, state: journal.state(effectId) } });
              const afterAck = (controlledFault?.operation === "effect" && controlledFault.phase === "after-ack" ? controlledFault : undefined) ?? faultFor(ast.faults, "effect", "after-ack");
              if (afterAck) throw faultError(afterAck);
              kernel.trace.emit({ type: "effect", id, data: { name, state: "resolved", ...(idempotencyKey ? { idempotencyKey } : {}) } }); return value;
            });
          },
          sleep: (ms: number) => new Promise<void>((resolve, reject) => {
            const wakeup = `${selected.id}:timer:${ms}`;
            let settled = false;
            const finish = (action: () => void) => { if (!settled) { settled = true; action(); } };
            journal.registerWakeup(wakeup);
            const eventBefore = faultFor(ast.faults, "event-append", "before-task");
            if (eventBefore) return reject(faultError(eventBefore));
            // Wakeup loss is the event-append transition itself: the fault
            // fires HERE, at the registered wakeup that fails to append, and
            // nowhere else. A callback that never sleeps never reaches it.
            const lostFault = faultFor(ast.faults, "event-append", "during-task") ?? faultFor(ast.faults, "event-append", "after-task");
            const timer = kernel.clock.sleep(ms, () => {
              const timerId = String(timer);
              const suppliedFire = runtimeKernel.controls.takeTimerFire(timerId);
              const wrongFire = runtimeKernel.controls.peek()?.type === "timer-fire" && !suppliedFire;
              if (wrongFire) { finish(() => reject(Object.assign(new Error(`CONTROL_OUT_OF_ORDER: timer ${timerId} was not the supplied timer target`), { code: "CONTROL_OUT_OF_ORDER", details: { expectedTimer: timerId, supplied: runtimeKernel.controls.peek() } }))); return; }
              if (lostFault) { journal.loseWakeup(wakeup); recordAmbiguity(ambiguity("lost-wakeup", { step: selected.id, wakeup, before: "registered", attempted: "wakeup", winner: "event-loss", after: "lost", transition: "registered->lost", journalState: journal.wakeupState(wakeup) }), id); finish(() => reject(lostFault.phase === "during-task" ? faultError(lostFault) : Object.assign(new Error("lost wakeup"), { code: "LOST_WAKEUP" }))); return; }
              journal.deliverWakeup(wakeup); if (!suppliedFire) runtimeKernel.controls.append({ type: "timer-fire", timer: timerId }); kernel.trace.emit({ type: "wait", id, data: { state: "timer-fired", ms, timer: timerId } }); finish(resolve);
            });
            cleanup.register("virtual-timer", String(timer), () => { kernel.clock.cancel(timer); finish(() => reject(Object.assign(new Error("task interrupted while sleeping"), { code: "TASK_INTERRUPTED" }))); });
          }),
          log: (message: string, data?: ScenarioValue) => kernel.trace.emit({ type: "task", id, data: { state: "log", message, ...(data === undefined ? {} : { data }) } }),
          opaque: <T>(name: string, operation: () => T | Promise<T>) => { kernel.trace.emit({ type: "opaque-effect", id, data: { name, controllable: false } }); return Promise.resolve().then(operation); },
        };
        let productionValue: unknown;
        if (runtimeKernel.controls.peek()?.type === "inject-fault") {
          const control = runtimeKernel.controls.takeNext("inject-fault")!;
          controlledFault = ast.faults.find((candidate) => candidate.id === control.fault);
          kernel.trace.emit({ type: "fault", id: control.fault, data: control.payload });
        }
        const extensionExecutor = selected.extension ? harness.adapter?.extensionExecutors?.[selected.extension] : undefined;
        if (selected.extension && !extensionExecutor) throw Object.assign(new Error(`UNREGISTERED_STEP_EXTENSION: ${selected.extension}`), { code: "UNREGISTERED_STEP_EXTENSION", details: { step: selected.id, extension: selected.extension } });
        if (selected.extension && extensionExecutor) yield* Effect.tryPromise({ try: () => Promise.resolve(extensionExecutor(selected.id, selected.input)), catch: (e) => adapterFailure(harness.adapter, e) });
        const runner = options.stepRunners?.[selected.id] ?? stepRunner(selected);
        // Task entry is the task/resume operation transition ONLY. An armed
        // inject-fault control never fires here for any other operation: its
        // declared fault fires solely at the matching operation middleware,
        // and an armed fault whose operation never transitions is reported as
        // an unconsumed control after the task completes, never as a fault.
        const barrierBeforeFault = faultFor(ast.faults, "task", "before-task")
          ?? (harness.kind === "unit-sim" && runner ? faultFor(ast.faults, "resume", "before-task") : undefined);
        if (barrierBeforeFault) throw faultError(barrierBeforeFault);
        const preCallbackBarrier = ast.barriers.find((item) => item.parties.includes(selected.id) && !releasedBarriers.has(item.id));
        const nextControl = runtimeKernel.controls.peek();
        if (preCallbackBarrier) {
          const gate = barrierGate(preCallbackBarrier.id);
          gate.arrived.add(selected.id);
          kernel.trace.emit({ type: "barrier", id: ids.next(preCallbackBarrier.id), data: { state: "parked", step: selected.id, released: false, beforeCallback: true } });
          const releaseControl = runtimeKernel.controls.peek();
          if (preCallbackBarrier.parties.every((party) => gate.arrived.has(party))) {
            if (releaseControl?.type === "release-barrier" && releaseControl.barrier === preCallbackBarrier.id) {
              runtimeKernel.controls.takeNext("release-barrier");
              releasedBarriers.add(preCallbackBarrier.id);
              kernel.trace.emit({ type: "barrier", id: ids.next(preCallbackBarrier.id), data: { state: "released", parties: preCallbackBarrier.parties } });
              gate.release();
            } else {
              throw Object.assign(new Error(`barrier ${preCallbackBarrier.id} timed out waiting for release`), { code: "BARRIER_TIMEOUT", details: { barrier: preCallbackBarrier.id, budget: preCallbackBarrier.budget } });
            }
          }
          yield* Effect.tryPromise({ try: () => gate.promise, catch: (cause) => cause });
        }
        const injectFault = harness.adapter?.injectFault;
        // Task middleware is distinct from operation middleware. The in-flight
        // callback IS the transition only for the task itself and the
        // simulated crash family that owns the task's lease (resume restart,
        // lease/heartbeat fencing, cancellation). `effect` and `event-append`
        // faults fire exclusively inside their taskRuntime middlewares below;
        // a callback that never crosses those boundaries is a non-occurrence,
        // never a simulated stand-in.
        const duringFault = ast.faults.find((candidate) => candidate.phase === "during-task" && (candidate.operation === "task" || candidate.operation === "resume" || candidate.operation === "lease" || candidate.operation === "heartbeat" || candidate.operation === "cancellation"));
        if (harness.adapter?.runStep && harness.kind !== "unit-sim") {
          const productionOperation = harness.kind === "e2e-real-process" ? "runWorkflow" : selected.id;
          const canonicalOperation = productionOperation.replace(/#\d+$/, "");
          const mappedOperation = harness.kind === "integration-real-db" ? dbOperationKind(productionOperation) : harness.kind === "e2e-real-process" ? processOperationKind(productionOperation) : undefined;
          // ONE operation/phase middleware around the actual adapter
          // transition: before-phase faults fire before the production call
          // ever runs, after/ack/during faults fire on its observed receipt,
          // and the admitted adapter's injectFault produces the native
          // observation at exactly that transition.
          const fireAtTransition = (candidate: ScenarioFault, invoked: boolean, observedResult: unknown) => Effect.gen(function* () {
            if (controlledFault?.id === candidate.id) controlledFaultObserved = true;
            const observation = injectFault
              ? yield* Effect.tryPromise({ try: () => Promise.resolve(injectFault(candidate, { operation: mappedOperation, phase: candidate.phase, stepId: selected.id, input: selected.input, invoked, result: observedResult })), catch: (e) => adapterFailure(harness.adapter, e) })
              : undefined;
            kernel.trace.emit({ type: "durability", id: ids.next(`${candidate.operation}:${candidate.phase}`), data: { operation: candidate.operation, phase: candidate.phase, receipt: { stepId: selected.id, faultId: candidate.id, productionOperation: canonicalOperation, invoked, adapter: harness.adapter!.identity, observation } } as unknown as ScenarioValue });
            return observation;
          });
          const transitionFault = (phase: ScenarioFault["phase"]) => (mappedOperation ? faultFor(ast.faults, mappedOperation, phase) : undefined);
          const beforeTransition = transitionFault("before-task");
          if (beforeTransition) { yield* fireAtTransition(beforeTransition, false, undefined); throw faultError(beforeTransition); }
          productionValue = yield* Effect.tryPromise({ try: () => Promise.resolve(harness.adapter!.runStep!(productionOperation, selected.input)), catch: (e) => adapterFailure(harness.adapter, e) });
          kernel.trace.emit({ type: "adapter", id, data: { identity: harness.adapter.identity, step: selected.id, executed: true } });
          // A real CAS result is an observed transition receipt. It is the
          // only source for these real-harness outcomes; the fault declaration
          // itself never manufactures ambiguity.
          if (canonicalOperation === "claimAttemptCompletion" && productionValue === false) {
            const input = selected.input as { runtimeOwnerId?: string | null } | undefined;
            recordAmbiguity(ambiguity(input?.runtimeOwnerId === "old-owner" ? "lease-lost" : "duplicate-delivery", {
              step: selected.id, before: "in-progress", attempted: "completion-cas", winner: "existing-owner-or-prior-completion", after: "unchanged", observed: false, transition: "completion-cas-rejected",
            }), id);
          }
          const duringTransitionFault = transitionFault("during-task");
          if (duringTransitionFault) {
            // The declaration only names the cut point; the ambiguity itself
            // must have been EXECUTED by the adapter as a production
            // transition and read back from durable state. No observed
            // takeover/race/restart receipt, no ambiguity.
            const rawReceipt = yield* fireAtTransition(duringTransitionFault, true, productionValue);
            if (harness.kind === "e2e-real-process") {
              // The receipt is the adapter's real observation: a SIGKILL
              // terminal event on the live child plus a verified
              // fresh-process resume read back from durable state. A missing,
              // mismatched, or non-resumed observation fails execution and
              // never manufactures ambiguity from the declaration alone.
              const observation = rawReceipt as RealProcessTransitionObservation | undefined;
              if (observation?.terminatedBy !== "SIGKILL" || observation.resumed !== true) throw faultError(duringTransitionFault);
              recordAmbiguity(ambiguity("restart-in-task", { step: selected.id, source: "real-process-observation", terminatedBy: observation.terminatedBy, resumedStatus: observation.resumedStatus, resumedOutputPersisted: observation.resumedOutputPersisted === true }), id);
              if (observation.preKillEffectApplied && !observation.journalWritten) recordAmbiguity(ambiguity("effect-applied-journal-missing", { step: selected.id, source: "real-process-observation", preKillEffectApplied: true, journalWritten: false, outputPersisted: observation.outputPersisted, resumedOutputPersisted: observation.resumedOutputPersisted === true }), id);
            } else {
              const transitionReceipt = rawReceipt as Readonly<{ observed?: Readonly<{ leaseTakeover?: Readonly<{ executed?: boolean; oldOwnerHeartbeatRejected?: boolean; previousOwner?: string | null; fencingOwner?: string; after?: unknown }>; cancellationRace?: Readonly<{ executed?: boolean; cancelRequested?: boolean; completionRejected?: boolean; winner?: string; after?: unknown }> }> }> | undefined;
              const takeover = transitionReceipt?.observed?.leaseTakeover;
              if (mappedOperation === "heartbeat" && takeover?.executed === true && takeover.oldOwnerHeartbeatRejected === true) {
                recordAmbiguity(ambiguity("lease-lost", { step: selected.id, source: "real-db-observation", attempted: "heartbeat", winner: "lease-takeover", before: "owned", after: "fenced", transition: "owned->fenced", previousOwner: takeover.previousOwner ?? null, fencingOwner: takeover.fencingOwner ?? null, observed: takeover.after }), id);
              }
              const race = transitionReceipt?.observed?.cancellationRace;
              if (mappedOperation === "cancellation" && race?.executed === true && race.cancelRequested === true && race.completionRejected === true) {
                recordAmbiguity(ambiguity("cancellation-race", { step: selected.id, source: "real-db-observation", attempted: "completion-cas", winner: "cancellation", transition: "cancel-requested->completion-fenced", observed: race.after }), id);
              }
              throw faultError(duringTransitionFault);
            }
          }
          const ackTransitionFault = transitionFault("after-journal-before-ack");
          // The ack cut point exists only AFTER the journal transition
          // actually applied. A production CAS returning false is durable
          // evidence of a rejected/duplicate attempt: no journal transition
          // occurred, so after-journal-before-ack is a non-occurrence — no
          // injectFault invocation, no journal-applied ambiguity, no fault.
          if (ackTransitionFault && (mappedOperation !== "completion-cas" || productionValue === true)) {
            const ackReceipt = (yield* fireAtTransition(ackTransitionFault, true, productionValue)) as Readonly<{ observed?: unknown }> | undefined;
            recordAmbiguity(ambiguity("journal-applied-ack-missing", { step: selected.id, source: "real-db-observation", before: "in-progress", attempted: "ack", winner: "journal-write", after: "journaled", observed: productionValue === true, durable: (ackReceipt?.observed ?? null) as ScenarioValue, transition: "journal-applied->ack-missing", fault: ackTransitionFault.id }), id);
            throw faultError(ackTransitionFault);
          }
          const afterTransitionFault = transitionFault("after-task");
          if (afterTransitionFault) { yield* fireAtTransition(afterTransitionFault, true, productionValue); throw faultError(afterTransitionFault); }
        }
        // Interruption/fault controls are rendezvous points before user code
        // starts. Applying them here makes cancellation and during-task faults
        // observable before a callback can finish synchronously.
        if (runtimeKernel.controls.peek()?.type === "cancel") {
          const cancel = runtimeKernel.controls.takeNext("cancel")!;
          recordAmbiguity(ambiguity("cancellation-race", { step: selected.id, reason: cancel.reason ?? "cancelled", transition: "task-started->cancelled" }), id);
          throw Object.assign(new Error(cancel.reason ?? "scenario cancelled"), { code: "SCENARIO_CANCELLED" });
        }
        if (controlledFault?.operation === "task" && controlledFault.phase === "during-task") { throw faultError(controlledFault); }
        // Lease, heartbeat, cancellation, and resume faults rendezvous after
        // the callback below, where a real task transition has occurred.
        // The kernel cannot inspect arbitrary user code. A callback is therefore
        // opaque unless it explicitly crosses taskRuntime.effect.
        if (runner) kernel.trace.emit({ type: "opaque-effect", id, data: { name: `step:${selected.id}`, controllable: false } });
        let value: unknown;
        const runTask = () => {
          // Invoke the author callback at the fiber rendezvous itself. Using
          // Promise.resolve().then(callback) hides a synchronous completion
          // behind an extra host turn and lets a cancellation fault claim a
          // race that never occurred. Every executable reaching this point
          // carries a caller-supplied binding (anonymous identities are
          // retired and rejected at admission), so the caller vouches for the
          // result's realm interactions.
          let returned: unknown;
          try { returned = runner!(runtime, selected.input); } catch (cause) { return Promise.reject(cause); }
          const pending = Promise.resolve(returned);
          cleanup.track({ kind: "task-fiber", id: selected.id }, pending);
          return pending;
        };
        if (runner && duringFault && harness.kind === "unit-sim") {
          const child = yield* Effect.fork(Effect.tryPromise({ try: () => runTask(), catch: (e) => e }));
          // Let the child cross the callback boundary before interrupting it;
          // an immediate interrupt is a cancellation-before-start, not a
          // cancellation race during a running task.
          yield* Effect.yieldNow();
          // Effect scheduling and a Promise-returning synchronous callback use
          // separate queues. Give the callback one host continuation to reach
          // its terminal state before polling; otherwise a completed callback
          // is misclassified as an interrupted race.
          yield* Effect.tryPromise({ try: () => Promise.resolve(), catch: (cause) => cause });
          const completedExit = yield* Fiber.poll(child);
          if (Option.isSome(completedExit)) {
            // The callback reached its terminal state before the crash window
            // opened: the in-flight transition never occurred, so the fault
            // stays inert and the completed value stands.
            value = yield* Fiber.join(child);
          } else {
            yield* Fiber.interrupt(child);
          if (duringFault.operation === "resume") {
            if (controlledFault?.id === duringFault.id) controlledFaultObserved = true;
            recordAmbiguity(ambiguity("restart-in-task", { step: selected.id, transition: "running->killed->restarted", winner: "resume" }), id);
            value = yield* Effect.tryPromise({ try: () => runTask(), catch: (e) => e });
          } else {
            if (duringFault.operation === "lease" || duringFault.operation === "heartbeat" || duringFault.operation === "cancellation") journal.loseLease(selected.id);
            if (duringFault.operation === "cancellation") recordAmbiguity(ambiguity("cancellation-race", { step: selected.id, transition: "running->cancelled", attempted: "cancellation", winner: "cancellation", before: "owned", after: "cancelled" }), id);
            if (duringFault.operation === "lease" || duringFault.operation === "heartbeat") recordAmbiguity(ambiguity("lease-lost", { step: selected.id, transition: "owned->fenced", attempted: "lease-takeover", winner: "lease-takeover", before: "owned", after: "fenced" }), id);
            throw faultError(duringFault);
          }
          }
        }
        if (runner && !duringFault) value = yield* Effect.tryPromise({ try: () => runTask(), catch: (e) => e });
        if (runtimeKernel.controls.peek()?.type === "cancel") {
          const cancel = runtimeKernel.controls.takeNext("cancel")!;
          recordAmbiguity(ambiguity("cancellation-race", { step: selected.id, reason: cancel.reason ?? "cancelled", transition: "task-completed->cancelled" }), id);
          throw Object.assign(new Error(cancel.reason ?? "scenario cancelled"), { code: "SCENARIO_CANCELLED" });
        }
        const pendingControl = runtimeKernel.controls.peek();
        if (pendingControl?.type === "task-restart" && pendingControl.step === selected.id) {
          runtimeKernel.controls.takeNext("task-restart");
          recordAmbiguity(ambiguity("restart-in-task", { step: selected.id, before: "completed", attempted: "resume", winner: "resume", after: "running", transition: "task-completed->restarted" }), id);
          if (runner) value = yield* Effect.tryPromise({ try: () => runTask(), catch: (e) => e });
        }
        // Every during-task transition already fired at its owning middleware:
        // the fork/interrupt rendezvous for the task/lease-holding family, the
        // effect middleware for mediated effects, the wakeup timer for event
        // append. After-task belongs to the task operation alone; other
        // operations' late phases fire inside their own middlewares.
        const after = faultFor(ast.faults, "task", "after-task");
        // The terminal completion transition occurs only when a task with a
        // runner actually completed. Event append is handled by the wait
        // middleware above, so neither operation fires for a plain no-op
        // task, and a task that failed or was interrupted before this point
        // never committed a completion.
        if (harness.kind === "unit-sim" && runner) simulatedCompletionTransition(selected.id, id);
        if (after) { throw faultError(after); }
        if (controlledFault && !controlledFaultObserved) {
          // The armed fault's operation/phase never transitioned during this
          // task: the control was supplied but is NOT an observation. Failing
          // here is the explicit unconsumed-control contract — the fault
          // itself never fires without its transition.
          throw Object.assign(new Error(`CONTROL_UNCONSUMED: inject-fault ${controlledFault.id} armed ${controlledFault.operation}:${controlledFault.phase} but the operation never transitioned`), { code: "CONTROL_UNCONSUMED", details: { fault: controlledFault.id, operation: controlledFault.operation, phase: controlledFault.phase } });
        }
        const finalValue = harness.kind === "unit-sim" ? value : productionValue;
        const rendezvous = ast.barriers.find((item) => item.parties.includes(selected.id) && !releasedBarriers.has(item.id));
        if (rendezvous) {
          // Arrival is a continuation boundary. The task fiber is observable
          // as parked before its completion is exposed to dependents; the
          // outer scheduler only records the value and waits for release.
          kernel.trace.emit({ type: "barrier", id: ids.next(rendezvous.id), data: { state: "parked", step: selected.id, released: false, beforeCompletion: true } });
        } else {
          kernel.trace.emit({ type: "task", id, data: { state: "finished", step: selected.id, resultDigest: canonicalize(finalValue === undefined ? null : finalValue) } });
        }
        return finalValue;
      }));
      for (const selected of executableOrdered) activeTaskIds.add(selected.id);
      // Start the ready set as fibers and consume whichever fiber actually
      // exits next. This is the transition point: newly-unblocked work is
      // scheduled immediately, rather than waiting for an unrelated ready
      // task (for example a sleeping sibling) to finish.
      const winner = yield* runtimeKernel.executor.runReadySet(tasks.map((effect, index) => ({ stepId: executableOrdered[index]!.id, effect })));
      activeTaskIds.delete(winner.stepId);
      const winnerBarrier = ast.barriers.find((item) => item.parties.includes(winner.stepId) && !releasedBarriers.has(item.id));
      if (winnerBarrier) {
        parkedValues.set(winner.stepId, winner.value);
        parked.add(winner.stepId);
        kernel.trace.emit({ type: "barrier", id: ids.next(winnerBarrier.id), data: { state: "parked", step: winner.stepId, released: false } });
      } else { outputs[winner.stepId] = winner.value; completed.add(winner.stepId); }
    }
    for (const item of ast.barriers) { const pendingRelease = kernel.controls.peek(); const release = pendingRelease?.type === "release-barrier" && pendingRelease.barrier === item.id ? kernel.controls.takeNext("release-barrier") : undefined; const released = release?.barrier === item.id || releasedBarriers.has(item.id); if (!released) throw Object.assign(new Error(`barrier ${item.id} timed out waiting for release`), { code: "BARRIER_TIMEOUT", details: { barrier: item.id, budget: item.budget } }); kernel.trace.emit({ type: "barrier", id: item.id, data: { state: "released", parties: item.parties } }); }
    const leftover = runtimeKernel.controls.pendingControls();
    if (leftover.length) throw Object.assign(new Error(`CONTROL_UNCONSUMED: ${leftover.map((control) => control.type).join(", ")}`), { code: "CONTROL_UNCONSUMED", details: { controls: leftover } });
    return outputs;
  });
  const execution = runAtBoundaryFork(program.pipe(Effect.provide(kernelLayer(kernel))));
  let result: Awaited<typeof execution.promise>;
  try {
    if (harness.kind === "unit-sim") result = await settleKernel(execution.promise, kernel, options.waitBudget ?? 10_000);
    else {
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([execution.promise, new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => reject(Object.assign(new Error("BOUNDED_WAIT_EXHAUSTED: real harness did not settle"), { code: "BOUNDED_WAIT_EXHAUSTED" })), Math.max(1, options.waitBudget ?? 10_000));
        })]);
      } finally { if (deadlineTimer !== undefined) clearTimeout(deadlineTimer); }
    }
  } catch (cause) { await execution.interrupt(); result = { ok: false, error: { name: "BoundedWaitError", code: (cause as { code?: string }).code ?? "BOUNDED_WAIT_EXHAUSTED", message: String(cause) } }; }
  let cleanupFailure: unknown;
  try { await cleanup.close(options.cleanupBudget ?? 100); } catch (cause) { cleanupFailure = cause; }
  try { assertNoLeaks(cleanup, kernel.clock.pending().map((timer) => ({ kind: "virtual-timer", id: String(timer.id) }))); } catch (cause) { cleanupFailure ??= cause; }
  if (cleanupFailure) {
    const primary = result.ok ? undefined : result.error;
    const cleanupCode = (cleanupFailure as { code?: string }).code === "CLEANUP_LEAK" ? "CLEANUP_LEAK" : "CLEANUP_FAILED";
    // A terminal task failure is the first observable result.  Cleanup is
    // still reported in details, but an interrupted sibling must not mask the
    // task's error with CLEANUP_LEAK/CLEANUP_FAILED.
    result = { ok: false, error: { name: cleanupCode === "CLEANUP_LEAK" ? "CleanupLeakError" : "CleanupError", code: cleanupCode, message: String((cleanupFailure as Error).message), cause: primary, details: { primary, cleanup: cleanupFailure } } };
  }
  if (kernel.trace.snapshot().some((event) => event.type === "opaque-effect")) residues.add("unmediated-opaque-effect");
  const finalControlLog = kernel.controls.log();
  const identityControls = kernel.controls.pendingControls().length ? replayControls : finalControlLog;
  const finalBase = { ...base, controlLog: finalControlLog, replayIdentity: replayIdentity({ ast, seed, controlLog: identityControls }), ambiguity: ambiguities, determinismReport: { deterministic: residues.size === 0, residues: [...residues] } };
  if (!result.ok && result.error.code === "ADMISSION_FAILED") {
    const kind = harness.kind === "e2e-real-process" ? "real-process" : "real-db";
    const skippedAdmission = harness.config.policy === "skip";
    return { ...finalBase, status: skippedAdmission ? "capability-skip" : "capability-failure", outputs, trace: kernel.trace.snapshot(), capabilityReport: [...capabilityReport, { kind: skippedAdmission ? "capability-skip" : "capability-failure", harness: harness.name, capability: kind, hint: result.error.message }], error: result.error };
  }
  return result.ok ? { ...finalBase, status: "finished", outputs: result.value, trace: kernel.trace.snapshot() } : { ...finalBase, status: "failed", outputs, trace: kernel.trace.snapshot(), error: result.error };
};
