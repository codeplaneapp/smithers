// src/runScenario.ts
import { Effect as Effect3, Fiber as Fiber3 } from "effect";

// src/scenario/replayIdentity.ts
import { createHash } from "crypto";

// src/scenario/canonicalize.ts
var CanonicalizeError = class extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
    this.name = "CanonicalizeError";
  }
  details;
  code = "CANONICALIZE_UNSUPPORTED";
};
var encode = (value, path = "$", seen = /* @__PURE__ */ new Set()) => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalizeError("Unsupported value at " + path);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new CanonicalizeError("Unsupported value at " + path);
  if (seen.has(value)) throw new CanonicalizeError("Circular value at " + path);
  seen.add(value);
  const result = Array.isArray(value) ? "[" + value.map((item, i) => encode(item, path + "[" + i + "]", seen)).join(",") + "]" : "{" + Object.keys(value).sort().map(
    (key) => JSON.stringify(key) + ":" + encode(value[key], path + "." + key, seen)
  ).join(",") + "}";
  seen.delete(value);
  return result;
};
var canonicalize = (value) => encode(value);

// src/scenario/replayIdentity.ts
var replayIdentity = (input) => "ri1:" + createHash("sha256").update(canonicalize({ ast: input.ast, seed: input.seed, controlLog: input.controlLog ?? [] })).digest("hex");

// src/kernel/KernelRuntime.ts
import { Context, Effect, Fiber, Layer, Result } from "effect";

// src/kernel/ControlBus.ts
var ControlBus = class {
  pending;
  observed = [];
  constructor(input = []) {
    this.pending = input.map((message) => Object.freeze({ ...message }));
  }
  /** Append the command at the point it happened. Supplied commands are never
   * searched for or reordered: a generated decision is part of the log even
   * when a later supplied rendezvous is still pending. */
  append(message) {
    const next = this.pending[0];
    if (next && JSON.stringify(next) === JSON.stringify(message)) this.pending.shift();
    this.observed.push(Object.freeze({ ...message }));
    return this.observed.length - 1;
  }
  /** Only rendezvoused controls are observations. Pending input is exposed
   * separately so replay cannot mistake unconsumed commands for evidence. */
  log() {
    return [...this.observed];
  }
  find(type) {
    return [...this.observed, ...this.pending].filter((message) => message.type === type);
  }
  /** Consume a command at its actual rendezvous and retain it in the replay log. */
  take(type) {
    const message = this.pending[0];
    if (message?.type === type) {
      this.pending.shift();
      this.observed.push(message);
      return message;
    }
    return void 0;
  }
  /** Advance-clock is consumed only at a virtual-clock rendezvous. */
  takeAdvanceClock() {
    return this.take("advance-clock");
  }
  /** Consume only the next command. Runtime commands are ordered. */
  takeNext(type) {
    const message = this.pending[0];
    if (!message || message.type !== type) return void 0;
    this.pending.shift();
    this.observed.push(message);
    return message;
  }
  /**
   * A rendezvous control is ordered, but applicability is part of the
   * rendezvous.  In particular, a pin for a step that is not ready must stay
   * pending until that step becomes ready; consuming it and generating a
   * replacement changes replay identity and can execute the wrong schedule.
   */
  takeApplicablePin(choices) {
    const message = this.pending[0];
    if (message?.type !== "pin-interleaving" || !choices.includes(message.choice)) return void 0;
    this.pending.shift();
    this.observed.push(message);
    return message;
  }
  peek() {
    return this.pending[0];
  }
  takeResolve(effect) {
    const message = this.pending[0];
    if (message?.type !== "resolve-effect" || message.effect !== effect) return void 0;
    this.pending.shift();
    this.observed.push(message);
    return message;
  }
  takeTimerFire(timer) {
    const message = this.pending[0];
    if (message?.type !== "timer-fire" || message.timer !== timer) return void 0;
    this.pending.shift();
    this.observed.push(message);
    return message;
  }
  consumed() {
    return this.observed.length;
  }
  pendingControls() {
    return [...this.pending];
  }
};

// src/kernel/SeededScheduler.ts
var SeededScheduler = class {
  state;
  decisions = [];
  constructor(seed) {
    this.state = seed >>> 0 || 1;
  }
  choose(ready, forcedIndex) {
    if (!ready.length) throw new Error("SCHEDULER_EMPTY_READY_SET");
    const index = forcedIndex === void 0 ? this.next() % ready.length : forcedIndex;
    if (index < 0 || index >= ready.length) throw new RangeError("SCHEDULER_INVALID_INTERLEAVING");
    this.decisions.push(index);
    return ready[index];
  }
  snapshot() {
    return [...this.decisions];
  }
  next() {
    this.state = Math.imul(this.state, 1664525) + 1013904223 >>> 0;
    return this.state;
  }
};

// src/kernel/TraceCollector.ts
var TraceCollector = class {
  constructor(clock) {
    this.clock = clock;
  }
  clock;
  events = [];
  emit(event) {
    const value = Object.freeze({ ...event, seq: this.events.length, at: this.clock.now() });
    this.events.push(value);
    return value;
  }
  snapshot() {
    return [...this.events];
  }
};

// src/kernel/VirtualClock.ts
var VirtualClock = class {
  current = 0;
  nextId = 0;
  timers = [];
  now() {
    return this.current;
  }
  sleep(ms, callback) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError("virtual sleep requires a finite non-negative duration");
    const timer = { id: this.nextId++, at: this.current + ms, callback };
    this.timers.push(timer);
    this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
    return timer.id;
  }
  cancel(id) {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError("virtual clock can only advance forwards");
    this.current += ms;
    this.flush();
  }
  advanceToNextTimer() {
    const timer = this.timers[0];
    if (!timer) return false;
    this.current = Math.max(this.current, timer.at);
    this.flush();
    return true;
  }
  runUntilIdle(limit = 1e4) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("virtual-time limit must be a positive integer");
    let steps = 0;
    while (this.timers.length) {
      const timer = this.timers[0];
      this.current = Math.max(this.current, timer.at);
      while (this.timers[0]?.at <= this.current) {
        if (++steps > limit)
          throw Object.assign(new Error("VIRTUAL_TIME_BUDGET_EXHAUSTED: virtual-time callback budget exhausted"), {
            code: "VIRTUAL_TIME_BUDGET_EXHAUSTED",
            details: { limit, now: this.current }
          });
        this.timers.shift()?.callback();
      }
    }
  }
  pending() {
    return [...this.timers];
  }
  clear() {
    this.timers = [];
  }
  flush() {
    let steps = 0;
    while (this.timers[0]?.at <= this.current) {
      if (++steps > 1e4)
        throw Object.assign(new Error("virtual-time callback budget exhausted"), {
          code: "VIRTUAL_TIME_BUDGET_EXHAUSTED"
        });
      this.timers.shift()?.callback();
    }
  }
};

// src/kernel/KernelRuntime.ts
var KernelRuntimeService = class extends Context.Service()("@smithers/testing/KernelRuntime") {
};
var kernelLayer = (kernel) => Layer.succeed(KernelRuntimeService, kernel);
var makeKernel = (seed, controls = []) => {
  const clock = new VirtualClock();
  const bus = new ControlBus(controls);
  const runtime = { clock, scheduler: new SeededScheduler(seed), controls: bus, trace: new TraceCollector(clock) };
  const active = /* @__PURE__ */ new Map();
  const executor = Object.freeze({
    // This is the kernel's scheduling boundary. Ready tasks are Effect values,
    // forked and raced by the Effect runtime; the public runner never owns the
    // task fibers or implements a Promise race itself.
    runReadySet: (tasks) => Effect.gen(function* () {
      const fresh = tasks.filter(({ stepId }) => !active.has(stepId));
      for (const { stepId, effect } of fresh) active.set(stepId, yield* Effect.forkChild(effect));
      if (!active.size) throw new Error("KERNEL_NO_ACTIVE_FIBERS");
      const winner = yield* Effect.raceAll(
        [...active.entries()].map(
          ([stepId, fiber]) => Fiber.join(fiber).pipe(
            Effect.result,
            Effect.map((exit) => ({ stepId, exit }))
          )
        )
      );
      active.delete(winner.stepId);
      if (Result.isFailure(winner.exit)) {
        yield* Effect.all([...active.values()].map((fiber) => Fiber.interrupt(fiber)));
        active.clear();
        return yield* Effect.fail(winner.exit.failure);
      }
      return { stepId: winner.stepId, value: winner.exit.success };
    })
  });
  return Object.freeze({ ...runtime, executor });
};

// src/kernel/boundary.ts
import { Cause, Effect as Effect2, Exit, Fiber as Fiber2, Option, Result as Result2 } from "effect";
var toHarnessError = (error) => {
  if (error && typeof error === "object") {
    const value = error;
    return {
      name: String(value.name ?? error.constructor?.name ?? "Error"),
      code: String(value.code ?? "HARNESS_ERROR"),
      message: String(value.message ?? error),
      ...value.fidelity === "simulation" || value.fidelity === "native" ? { fidelity: value.fidelity } : {},
      ...typeof value.tag === "string" ? { tag: value.tag } : {},
      ...typeof value.summary === "string" ? { summary: value.summary } : {},
      ...typeof value.docsUrl === "string" ? { docsUrl: value.docsUrl } : {},
      ...value.serialized === void 0 ? {} : { serialized: value.serialized },
      ...value.details === void 0 ? {} : { details: value.details },
      ...value.cause === void 0 ? {} : { cause: toHarnessError(value.cause) }
    };
  }
  return { name: "Error", code: "HARNESS_ERROR", message: String(error) };
};
var squashCause = (cause) => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) return failure.value;
  const defect = Cause.findDefect(cause);
  return Result2.isSuccess(defect) ? defect.success : new Error("kernel program failed");
};
var runAtBoundaryFork = (program) => {
  const fiber = Effect2.runFork(Effect2.exit(program));
  const promise = Effect2.runPromise(Fiber2.join(fiber)).then((exit) => {
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
    return { ok: false, error: toHarnessError(squashCause(exit.cause)) };
  });
  return { promise, interrupt: () => Effect2.runPromise(Fiber2.interrupt(fiber)) };
};

// src/internal/deterministicIds.ts
var mix = (value) => {
  value = Math.imul(value ^ value >>> 16, 73244475);
  value = Math.imul(value ^ value >>> 16, 73244475);
  return (value ^ value >>> 16) >>> 0;
};
var deterministicIds = (seed) => {
  let state = mix(seed >>> 0);
  return {
    next: (prefix = "id") => {
      state = mix(state + 2654435769);
      return prefix + "-" + state.toString(36).padStart(7, "0");
    },
    snapshot: () => state
  };
};

// src/harness/capabilities.ts
var admitCapabilities = (harness, requested, policy = "fail") => requested.map(
  (capability) => harness.capabilities.has(capability) ? { kind: "supported", harness: harness.name, capability } : {
    kind: policy === "skip" ? "capability-skip" : "capability-failure",
    harness: harness.name,
    capability,
    hint: "Choose a harness that declares this capability."
  }
);
var requiredCapabilities = (ast) => {
  const result = /* @__PURE__ */ new Set();
  for (const step of ast.steps) for (const capability of step.capabilities) result.add(capability);
  if (ast.barriers.length) result.add("barriers");
  if (ast.faults.length) result.add("durability-faults");
  if (ast.extensions.length) result.add("explicit-interleaving");
  return [...result];
};

// src/harness/Harness.ts
var trustedAdapters = /* @__PURE__ */ new WeakMap();
var trustedAdapterKind = (adapter) => trustedAdapters.get(adapter);
function makeHarness(kind, config = {}) {
  const defaults = {
    "unit-sim": [
      "virtual-time",
      "seeded-interleaving",
      "explicit-interleaving",
      "barriers",
      "mediated-effects",
      "durability-faults"
    ],
    "integration-real-db": [
      "virtual-time",
      "seeded-interleaving",
      "explicit-interleaving",
      "barriers",
      "mediated-effects",
      "real-db",
      "native-error-parity",
      "durability-faults"
    ],
    "e2e-real-process": ["real-process", "native-error-parity", "durability-faults"]
  };
  const requestedCapabilities = (config.capabilities ?? defaults[kind]).filter(
    (capability) => !(capability === "native-error-parity" && typeof config.adapter?.serializeError !== "function")
  );
  const forbiddenForUnit = /* @__PURE__ */ new Set(["real-db", "real-process", "native-error-parity"]);
  const capabilities = new Set(
    kind === "unit-sim" ? requestedCapabilities.filter((capability) => !forbiddenForUnit.has(capability)) : requestedCapabilities
  );
  const name = config.name ?? kind;
  const admit = (requested) => {
    const decisions = admitCapabilities({ name, capabilities }, requested, config.policy ?? "fail");
    const forbidden = requested.filter((capability) => forbiddenForUnit.has(capability));
    if (kind === "unit-sim" && forbidden.length)
      return [
        ...decisions,
        ...forbidden.map((capability) => ({
          kind: config.policy === "skip" ? "capability-skip" : "capability-failure",
          harness: name,
          capability,
          hint: "unit-sim cannot claim a real production capability"
        }))
      ];
    const crossKind = requestedCapabilities.some(
      (capability) => kind === "integration-real-db" && capability === "real-process" || kind === "e2e-real-process" && (capability === "real-db" || ["virtual-time", "seeded-interleaving", "explicit-interleaving", "barriers"].includes(capability))
    );
    if (kind !== "unit-sim" && (crossKind || !config.adapter || trustedAdapterKind(config.adapter) !== kind || typeof config.adapter.admissionProbe !== "function" || typeof config.adapter.runStep !== "function" || !config.adapter.verifiedProductionIdentity)) {
      const capability = kind === "e2e-real-process" ? "real-process" : "real-db";
      return [
        ...decisions,
        {
          kind: config.policy === "skip" ? "capability-skip" : "capability-failure",
          harness: name,
          capability,
          hint: "declaration is not proof: a verified production adapter with admissionProbe, runStep, and identity is required"
        }
      ];
    }
    return decisions;
  };
  return {
    name,
    kind,
    capabilities,
    config,
    adapter: config.adapter,
    admit,
    admitScenario: (ast, requested = []) => admit([...requiredCapabilities(ast), ...requested])
  };
}
var unitSimHarness = (config = {}) => makeHarness("unit-sim", config);

// src/scenario/compile.ts
var validPairs = /* @__PURE__ */ new Set([
  "task:before-task",
  "task:during-task",
  "task:after-task",
  "effect:before-task",
  "effect:during-task",
  "effect:after-effect-before-journal",
  "effect:after-journal-before-ack",
  "effect:after-ack",
  "attempt-write:before-task",
  "attempt-write:after-journal-before-ack",
  "event-append:before-task",
  "event-append:during-task",
  "event-append:after-task",
  "completion-cas:before-task",
  "completion-cas:after-journal-before-ack",
  "completion-cas:after-task",
  "heartbeat:during-task",
  "lease:during-task",
  "resume:before-task",
  "resume:during-task",
  "cancellation:during-task"
]);
var compileScenario = (ast, registeredExtensions = /* @__PURE__ */ new Set()) => {
  const diagnostics = [];
  const ids = /* @__PURE__ */ new Set();
  for (const step of ast.steps) {
    if (ids.has(step.id))
      diagnostics.push({ code: "DUPLICATE_STEP_ID", message: `duplicate step id ${step.id}`, node: step.id });
    ids.add(step.id);
  }
  const graph = new Map(ast.steps.map((s) => [s.id, s.dependsOn]));
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      diagnostics.push({ code: "DEPENDENCY_CYCLE", message: `dependency cycle includes ${id}`, node: id });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep))
        diagnostics.push({ code: "UNKNOWN_DEPENDENCY", message: `${id} depends on unknown step ${dep}`, node: id });
      else visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  const barriers = new Set(ast.barriers.map((b) => b.id));
  for (const b of ast.barriers) {
    if (!Number.isInteger(b.budget) || b.budget < 1)
      diagnostics.push({ code: "INVALID_BARRIER_BUDGET", message: `barrier ${b.id} has invalid budget`, node: b.id });
    for (const party of b.parties)
      if (!ids.has(party))
        diagnostics.push({
          code: "UNKNOWN_BARRIER_PARTY",
          message: `barrier ${b.id} names unknown step ${party}`,
          node: b.id
        });
    if (barriers.has(b.id) && ast.barriers.indexOf(b) !== ast.barriers.findIndex((x) => x.id === b.id))
      diagnostics.push({ code: "DUPLICATE_BARRIER_ID", message: `duplicate barrier id ${b.id}`, node: b.id });
  }
  for (const f of ast.faults)
    if (!validPairs.has(`${f.operation}:${f.phase}`) && !(f.operation === "task" && ["before-task", "during-task", "after-task"].includes(f.phase)))
      diagnostics.push({
        code: "UNSUPPORTED_FAULT_CUT_POINT",
        message: `fault ${f.id} cannot target ${f.operation} at ${f.phase}`,
        node: f.id
      });
  for (const ext of ast.extensions)
    if (!registeredExtensions.has(ext.name))
      diagnostics.push({
        code: "UNREGISTERED_EXTENSION",
        message: `extension ${ext.name} has no executor`,
        node: ext.name
      });
  for (const step of ast.steps)
    if (step.extension && !registeredExtensions.has(step.extension))
      diagnostics.push({
        code: "UNREGISTERED_STEP_EXTENSION",
        message: `step ${step.id} references extension ${step.extension} with no executor`,
        node: step.id
      });
  return diagnostics.length ? { ok: false, diagnostics, requiredCapabilities: requiredCapabilities(ast) } : { ok: true, requiredCapabilities: requiredCapabilities(ast) };
};

// src/scenario/builder.ts
var intrinsicFunctionToString = Function.prototype.toString;
var runners = /* @__PURE__ */ new WeakMap();
var runnersByBinding = /* @__PURE__ */ new Map();
var validRunnerBinding = (binding) => typeof binding === "string" && binding.trim().length > 0;
var stepRunner = (stepValue) => runners.get(stepValue) ?? (validRunnerBinding(stepValue.runnerBinding) ? runnersByBinding.get(stepValue.runnerBinding) : void 0);

// src/cleanup/CleanupScope.ts
var CleanupScope = class {
  entries = [];
  live = /* @__PURE__ */ new Map();
  liveSequence = 0;
  closed = false;
  add(resource, dispose) {
    if (this.closed) throw new Error("CLEANUP_SCOPE_CLOSED");
    const entry = { resource, dispose };
    this.entries.push(entry);
    return () => {
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
    };
  }
  register(kind, id, dispose) {
    return this.add({ kind, id }, dispose);
  }
  pending() {
    return this.entries.map((e) => e.resource);
  }
  track(resource, operation) {
    const key = `${resource.kind}/${resource.id}#${this.liveSequence++}`;
    this.live.set(key, { resource, operation });
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.live.delete(key);
      }
    };
    void operation.then(release, release);
    return release;
  }
  liveResources() {
    return [...this.live.values()].map((entry) => entry.resource);
  }
  async close(budget = 100, timeoutMs = 1e3) {
    this.closed = true;
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    let error;
    const failed = [];
    while (this.entries.length) {
      if (++count > budget || Date.now() >= deadline) {
        error ??= Object.assign(new Error("CLEANUP_FAILED: cleanup budget exhausted"), { code: "CLEANUP_FAILED" });
        break;
      }
      const entry = this.entries.pop();
      let disposed = false;
      try {
        let timer;
        try {
          await Promise.race([
            Promise.resolve(entry.dispose()),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(
                  Object.assign(new Error(`cleanup timed out: ${entry.resource.kind}/${entry.resource.id}`), {
                    code: "CLEANUP_TIMEOUT"
                  })
                ),
                Math.max(0, deadline - Date.now())
              );
            })
          ]);
          disposed = true;
        } finally {
          if (timer !== void 0) clearTimeout(timer);
        }
      } catch (cause) {
        error ??= Object.assign(new Error(`CLEANUP_FAILED: ${entry.resource.kind}/${entry.resource.id}`), {
          code: "CLEANUP_FAILED",
          cause
        });
      }
      if (!disposed) failed.push(entry);
    }
    this.entries.push(...failed.reverse());
    const pending = [...this.live.values()];
    if (pending.length && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled(pending.map((entry) => entry.operation)),
        new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))
      ]);
    }
    if (error) throw error;
  }
};

// src/cleanup/leakAssertions.ts
var assertNoLeaks = (scope, extra = []) => {
  const leaks = [...scope.pending(), ...scope.liveResources(), ...extra];
  if (leaks.length)
    throw Object.assign(new Error(`CLEANUP_LEAK: ${leaks.map((x) => `${x.kind}/${x.id}`).join(", ")}`), {
      code: "CLEANUP_LEAK",
      details: { leaks }
    });
};

// src/durability/journalModel.ts
var JournalModel = class {
  states = /* @__PURE__ */ new Map();
  leases = /* @__PURE__ */ new Map();
  owners = /* @__PURE__ */ new Map();
  wakeups = /* @__PURE__ */ new Map();
  state(id) {
    return this.states.get(id) ?? "none";
  }
  effectApplied(id) {
    this.states.set(id, "effect-applied");
  }
  journal(id) {
    if (this.state(id) === "journaled" || this.state(id) === "acked") return false;
    this.states.set(id, "journaled");
    return true;
  }
  ack(id) {
    if (this.state(id) !== "journaled")
      throw Object.assign(new Error(`cannot ack unjournaled effect ${id}`), { code: "JOURNAL_ACK_WITHOUT_WRITE" });
    this.states.set(id, "acked");
  }
  claimLease(id, owner) {
    const current = this.leases.get(id);
    if (current === "owned") return false;
    this.leases.set(id, "owned");
    this.owners.set(id, owner);
    return true;
  }
  assertLease(id, owner) {
    if (this.leaseState(id) !== "owned" || this.owners.get(id) !== owner)
      throw Object.assign(new Error(`lease fenced for ${id}`), {
        code: "LEASE_FENCED",
        details: { id, owner, currentOwner: this.owners.get(id) }
      });
  }
  loseLease(id) {
    this.leases.set(id, "lost");
    this.owners.delete(id);
  }
  leaseState(id) {
    return this.leases.get(id) ?? "unclaimed";
  }
  registerWakeup(id) {
    this.wakeups.set(id, "registered");
  }
  deliverWakeup(id) {
    if (this.wakeups.get(id) === "registered") this.wakeups.set(id, "delivered");
  }
  loseWakeup(id) {
    this.wakeups.set(id, "lost");
  }
  wakeupState(id) {
    return this.wakeups.get(id) ?? "none";
  }
  snapshot() {
    return {
      journal: Object.fromEntries(this.states),
      leases: Object.fromEntries(this.leases),
      wakeups: Object.fromEntries(this.wakeups)
    };
  }
};

// src/durability/ambiguity.ts
var ambiguity = (outcome, details = {}) => Object.freeze({
  outcome,
  guaranteed: outcome === "journal-applied-ack-missing" ? "journal-cas-only" : "at-least-once",
  details: Object.freeze({ ...details })
});

// src/runWorkflowScenario.ts
function isEffectLike(value) {
  return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}
async function settleRunResult(raw) {
  let value = raw;
  if (isEffectLike(value)) {
    const { Effect: Effect4 } = await import("effect");
    value = await Effect4.runPromise(value);
  }
  if (value && typeof value === "object" && "then" in value && typeof value.then === "function") {
    value = await value;
  }
  if (value && typeof value === "object") {
    return value;
  }
  return { value };
}
async function runWorkflowScenario(options) {
  const runId = typeof options.runId === "string" && options.runId !== "" ? options.runId : `scenario-${Date.now().toString(36)}`;
  const clock = options.clock ?? {
    nowMs: () => Date.now(),
    advance: () => void 0,
    advanceToNextTimer: () => void 0,
    pending: () => []
  };
  if (options.beforeRun) {
    await options.beforeRun({ runId, clock });
  }
  const rootDir = typeof options.rootDir === "string" && options.rootDir !== "" ? options.rootDir : process.cwd();
  const runOpts = {
    runId,
    rootDir,
    // Engine requires input object (even empty).
    input: options.input ?? {},
    resume: options.resume === true
  };
  if (options.onProgress) {
    runOpts.onProgress = options.onProgress;
  }
  let runWorkflowFn = options.runWorkflowFn;
  if (!runWorkflowFn) {
    const mod = await import("smithers-orchestrator");
    const rw = mod.runWorkflow;
    if (typeof rw !== "function") {
      throw new Error("runWorkflowScenario: smithers-orchestrator.runWorkflow not available; pass runWorkflowFn");
    }
    runWorkflowFn = rw;
  }
  const raw = await Promise.resolve(runWorkflowFn(options.workflow, runOpts));
  const result = await settleRunResult(raw);
  const status = typeof result.status === "string" ? result.status : typeof result.run?.status === "string" ? String(result.run.status) : "unknown";
  const resolvedRunId = typeof result.runId === "string" && result.runId !== "" ? result.runId : typeof result.run?.runId === "string" ? String(result.run.runId) : runId;
  return {
    runId: resolvedRunId,
    status,
    result,
    clock
  };
}

// src/runScenario.ts
var faultFor = (faults, operation, phase) => faults.find((fault) => fault.operation === operation && fault.phase === phase);
var dbOperationKind = (name) => {
  const base = name.replace(/#\d+$/, "");
  if (base === "claimAttemptCompletion" || base === "completeRun") return "completion-cas";
  if (base === "claimRunForResume") return "resume";
  if (base === "heartbeatRun" || base === "heartbeatAttempt") return "heartbeat";
  if (base === "requestRunCancel" || base === "claimRunCancellation") return "cancellation";
  return void 0;
};
var processOperationKind = (name) => name.replace(/#\d+$/, "") === "runWorkflow" ? "resume" : void 0;
var faultError = (fault) => Object.assign(new Error(`fault injected at ${fault.id}`), {
  code: "DURABILITY_FAULT_INJECTED",
  details: fault,
  fidelity: "simulation"
});
var adapterFailure = (adapter, cause) => {
  if (!adapter) return cause;
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return Object.assign(error, {
    fidelity: "native",
    ...adapter.serializeError ? { serialized: adapter.serializeError(cause) } : {}
  });
};
var settleKernel = async (promise, kernel, budget) => {
  let done = false;
  let value;
  let error;
  void promise.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      error = e;
    }
  );
  for (let turn = 0; !done && turn < budget; turn++) {
    for (let dispatcherTurn = 0; dispatcherTurn < Math.min(64, Math.max(1, budget)); dispatcherTurn++) {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      if (done) break;
    }
    if (!done) {
      const advance = kernel.controls.takeAdvanceClock();
      if (advance) kernel.clock.advance(advance.ms);
      else if (kernel.clock.pending().length) kernel.clock.advanceToNextTimer();
    }
  }
  if (!done)
    throw Object.assign(new Error("BOUNDED_WAIT_EXHAUSTED: kernel did not settle"), {
      code: "BOUNDED_WAIT_EXHAUSTED",
      details: { budget }
    });
  if (error !== void 0) throw error;
  return value;
};
var runKernelScenario = async (ast, options = {}) => {
  const seed = options.seed ?? ast.seed ?? 0;
  const harness = options.harness ?? unitSimHarness();
  const kernel = makeKernel(seed, options.controlLog ?? []);
  const unboundRunner = ast.steps.filter(
    (step) => (options.stepRunners?.[step.id] !== void 0 || stepRunner(step) !== void 0) && !validRunnerBinding(step.runnerBinding)
  ).map((step) => step.id);
  const invalidBinding = ast.steps.filter((step) => step.runnerBinding !== void 0 && !validRunnerBinding(step.runnerBinding)).map((step) => step.id);
  const retiredBinding = ast.steps.filter((step) => typeof step.runnerBinding === "string" && step.runnerBinding.startsWith("anonymous:")).map((step) => step.id);
  const capabilityReport = harness.admitScenario(ast, options.capabilities ?? []);
  const compiled = compileScenario(ast, new Set(Object.keys(harness.adapter?.extensionExecutors ?? {})));
  const knownFaults = new Set(ast.faults.map((item) => item.id));
  const invalidControl = (options.controlLog ?? []).find(
    (control) => control.type === "inject-fault" && !knownFaults.has(control.fault) || control.type === "release-barrier" && !ast.barriers.some((item) => item.id === control.barrier) || control.type === "task-restart" && !ast.steps.some((item) => item.id === control.step)
  );
  for (const decision of capabilityReport)
    kernel.trace.emit({ type: "capability", data: { kind: decision.kind, capability: decision.capability } });
  const replayControls = options.controlLog ?? [];
  const base = {
    replayIdentity: replayIdentity({ ast, seed, controlLog: replayControls }),
    controlLog: kernel.controls.log(),
    capabilityReport,
    ambiguity: [],
    determinismReport: { deterministic: true, residues: [] }
  };
  if (unboundRunner.length)
    return {
      ...base,
      status: "failed",
      outputs: {},
      trace: kernel.trace.snapshot(),
      error: {
        name: "ReplayIdentityError",
        code: "RUNNER_BINDING_REQUIRED",
        message: `step runner(s) require explicit stable runnerBinding: ${unboundRunner.join(", ")}`,
        details: { steps: unboundRunner },
        fidelity: "simulation"
      }
    };
  if (invalidBinding.length)
    return {
      ...base,
      status: "failed",
      outputs: {},
      trace: kernel.trace.snapshot(),
      error: {
        name: "ReplayIdentityError",
        code: "RUNNER_BINDING_INVALID",
        message: `runnerBinding must be a non-empty stable string: ${invalidBinding.join(", ")}`,
        details: { steps: invalidBinding },
        fidelity: "simulation"
      }
    };
  if (retiredBinding.length)
    return {
      ...base,
      status: "failed",
      outputs: {},
      trace: kernel.trace.snapshot(),
      error: {
        name: "ReplayIdentityError",
        code: "RUNNER_BINDING_CONFLICT",
        message: `the anonymous: binding namespace is retired framework-issued identity and cannot execute: ${retiredBinding.join(", ")}`,
        details: { steps: retiredBinding },
        fidelity: "simulation"
      }
    };
  const failed = capabilityReport.find((d) => d.kind === "capability-failure");
  const skipped = capabilityReport.find((d) => d.kind === "capability-skip");
  if (failed || skipped)
    return {
      ...base,
      status: failed ? "capability-failure" : "capability-skip",
      outputs: {},
      trace: kernel.trace.snapshot(),
      ...failed && harness.kind !== "unit-sim" ? {
        error: {
          name: "HarnessCapabilityError",
          code: "ADMISSION_FAILED",
          message: failed.hint ?? "real harness admission failed",
          details: failed,
          fidelity: "native"
        }
      } : {}
    };
  if (invalidControl)
    return {
      ...base,
      status: "failed",
      outputs: {},
      trace: kernel.trace.snapshot(),
      error: {
        name: "ControlError",
        code: "CONTROL_INVALID",
        message: `control ${invalidControl.type} is not applicable to this scenario`,
        details: invalidControl,
        fidelity: "simulation"
      }
    };
  if (!compiled.ok)
    return {
      ...base,
      status: "failed",
      outputs: {},
      trace: kernel.trace.snapshot(),
      error: {
        name: "ScenarioCompileError",
        code: "SCENARIO_INVALID",
        message: compiled.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "),
        details: compiled.diagnostics,
        fidelity: "simulation"
      }
    };
  if (harness.kind !== "unit-sim" && !harness.adapter)
    return {
      ...base,
      status: "capability-failure",
      outputs: {},
      trace: kernel.trace.snapshot(),
      capabilityReport: [
        ...capabilityReport,
        {
          kind: "capability-failure",
          harness: harness.name,
          capability: harness.kind === "e2e-real-process" ? "real-process" : "real-db",
          hint: "declaration is not proof: an executable adapter is required"
        }
      ]
    };
  if (harness.kind !== "unit-sim" && harness.adapter) {
    const unsupported = ast.faults.filter(
      (candidate) => !harness.adapter?.supportedCutPoints?.has(`${candidate.operation}:${candidate.phase}`)
    );
    if (unsupported.length) {
      const error = {
        name: "HarnessCapabilityError",
        code: "ADMISSION_FAILED",
        message: `real harness cannot execute requested cut point(s): ${unsupported.map((item) => `${item.operation}:${item.phase}`).join(", ")}`,
        details: { unsupported },
        fidelity: "native"
      };
      const decision = {
        kind: harness.config.policy === "skip" ? "capability-skip" : "capability-failure",
        harness: harness.name,
        capability: "durability-faults",
        hint: error.message
      };
      return {
        ...base,
        status: decision.kind === "capability-skip" ? "capability-skip" : "capability-failure",
        outputs: {},
        trace: kernel.trace.snapshot(),
        capabilityReport: [...capabilityReport, decision],
        error
      };
    }
  }
  const outputs = {};
  const parkedValues = /* @__PURE__ */ new Map();
  const completed = /* @__PURE__ */ new Set();
  const parked = /* @__PURE__ */ new Set();
  const releasedBarriers = /* @__PURE__ */ new Set();
  const cleanup = new CleanupScope();
  const journal = new JournalModel();
  const ambiguities = [];
  const residues = /* @__PURE__ */ new Set();
  const ids = deterministicIds(seed);
  const recordAmbiguity = (item, id) => {
    ambiguities.push(item);
    kernel.trace.emit({
      type: "ambiguity",
      id,
      data: { outcome: item.outcome, details: item.details }
    });
  };
  const program = Effect3.gen(function* () {
    if (harness.adapter) {
      cleanup.register("harness", harness.name, harness.adapter.cleanup ?? (() => void 0));
      yield* Effect3.tryPromise({
        try: () => Promise.resolve(harness.adapter.admissionProbe()),
        catch: (cause) => Object.assign(new Error(`ADMISSION_FAILED: ${harness.name} did not admit its production system`), {
          code: "ADMISSION_FAILED",
          cause,
          details: { native: harness.adapter?.serializeError?.(cause) }
        })
      });
      for (const extension of ast.extensions) {
        const executor = harness.adapter.extensionExecutors?.[extension.name];
        if (!executor)
          throw Object.assign(new Error(`UNREGISTERED_EXTENSION: ${extension.name}`), {
            code: "UNREGISTERED_EXTENSION",
            details: { extension: extension.name }
          });
        yield* Effect3.tryPromise({
          try: () => Promise.resolve(executor(extension.name, extension.value)),
          catch: (cause) => adapterFailure(harness.adapter, cause)
        });
        kernel.trace.emit({
          type: "adapter",
          id: extension.name,
          data: { identity: harness.adapter.identity, extension: extension.name, executed: true }
        });
      }
    }
    const runtimeKernel = yield* KernelRuntimeService;
    const activeTaskIds = /* @__PURE__ */ new Set();
    const barrierGates = /* @__PURE__ */ new Map();
    const barrierGate = (barrierId) => {
      const existing = barrierGates.get(barrierId);
      if (existing) return existing;
      let release;
      const gate = {
        arrived: /* @__PURE__ */ new Set(),
        promise: new Promise((resolve) => {
          release = resolve;
        }),
        release
      };
      barrierGates.set(barrierId, gate);
      return gate;
    };
    const applyCutPoint = (operation, phase, stepId) => {
      const candidate = ast.faults.find((item) => item.operation === operation && item.phase === phase);
      if (!candidate) return;
      const receipt = {
        before: "runnable",
        attempted: `${operation}:${phase}`,
        winner: "fault",
        after: "failed",
        stepId,
        faultId: candidate.id
      };
      kernel.trace.emit({
        type: "durability",
        id: ids.next(`${operation}:${phase}`),
        data: { operation, phase, receipt }
      });
      throw faultError(candidate);
    };
    const simulatedCompletionTransition = (stepId, taskId) => {
      if (harness.kind !== "unit-sim") return;
      if (!ast.faults.some((candidate) => candidate.operation === "completion-cas")) return;
      const completionKey = `${stepId}:completion`;
      const emitReceipt = (phase, receipt) => kernel.trace.emit({
        type: "durability",
        id: ids.next(`completion-cas:${phase}`),
        data: { operation: "completion-cas", phase, receipt }
      });
      const before = faultFor(ast.faults, "completion-cas", "before-task");
      if (before) {
        emitReceipt("before-task", {
          before: "task-completed",
          attempted: "completion-cas",
          winner: "fault",
          after: "not-committed",
          stepId,
          faultId: before.id,
          journalState: journal.state(completionKey)
        });
        throw faultError(before);
      }
      if (!journal.journal(completionKey))
        throw Object.assign(new Error(`duplicate completion journal write ${completionKey}`), {
          code: "JOURNAL_DUPLICATE"
        });
      kernel.trace.emit({
        type: "durability",
        id: taskId,
        data: { operation: "completion-journal-write", step: stepId, state: journal.state(completionKey) }
      });
      const ackFault = faultFor(ast.faults, "completion-cas", "after-journal-before-ack");
      if (ackFault) {
        recordAmbiguity(
          ambiguity("journal-applied-ack-missing", {
            step: stepId,
            before: "completion-journaled",
            attempted: "ack",
            winner: "journal-write",
            after: "journaled",
            transition: "completion-journal-applied->ack-missing",
            journalState: journal.state(completionKey),
            fault: ackFault.id
          }),
          taskId
        );
        emitReceipt("after-journal-before-ack", {
          before: "completion-journaled",
          attempted: "ack",
          winner: "fault",
          after: "journaled-unacked",
          stepId,
          faultId: ackFault.id,
          journalState: journal.state(completionKey)
        });
        throw faultError(ackFault);
      }
      journal.ack(completionKey);
      kernel.trace.emit({
        type: "durability",
        id: taskId,
        data: { operation: "completion-ack", step: stepId, state: journal.state(completionKey) }
      });
      const afterCompletion = faultFor(ast.faults, "completion-cas", "after-task");
      if (afterCompletion) {
        emitReceipt("after-task", {
          before: "completion-acked",
          attempted: "post-completion",
          winner: "fault",
          after: "acked",
          stepId,
          faultId: afterCompletion.id,
          journalState: journal.state(completionKey)
        });
        throw faultError(afterCompletion);
      }
    };
    let controlIndex = 0;
    while (runtimeKernel.controls.peek()?.type === "advance-clock")
      runtimeKernel.clock.advance(runtimeKernel.controls.takeAdvanceClock().ms);
    while (completed.size < ast.steps.length) {
      for (const barrier of ast.barriers) {
        const arrived = barrier.parties.every((party) => parked.has(party));
        if (arrived && !releasedBarriers.has(barrier.id)) {
          const release = runtimeKernel.controls.peek()?.type === "release-barrier" ? runtimeKernel.controls.takeNext("release-barrier") : void 0;
          if (release?.barrier === barrier.id) {
            releasedBarriers.add(barrier.id);
            for (const party of barrier.parties) {
              parked.delete(party);
              completed.add(party);
              if (parkedValues.has(party)) outputs[party] = parkedValues.get(party);
              parkedValues.delete(party);
            }
            kernel.trace.emit({
              type: "barrier",
              id: ids.next(barrier.id),
              data: { state: "released", parties: barrier.parties }
            });
          }
        }
      }
      if (completed.size === ast.steps.length) break;
      const ready = ast.steps.filter(
        (s) => !completed.has(s.id) && !parked.has(s.id) && !activeTaskIds.has(s.id) && s.dependsOn.every((d) => completed.has(d))
      );
      if (!ready.length && !activeTaskIds.size) {
        const waiting = ast.barriers.find(
          (barrier) => barrier.parties.every((party) => parked.has(party)) && !releasedBarriers.has(barrier.id)
        );
        if (waiting)
          throw Object.assign(new Error(`barrier ${waiting.id} timed out waiting for release`), {
            code: "BARRIER_TIMEOUT",
            details: { barrier: waiting.id, budget: waiting.budget }
          });
        throw Object.assign(new Error("no runnable steps remain"), { code: "SCENARIO_DEPENDENCY_UNSATISFIED" });
      }
      if (!ready.length) {
        const winner2 = yield* runtimeKernel.executor.runReadySet([]);
        activeTaskIds.delete(winner2.stepId);
        const winnerBarrier2 = ast.barriers.find(
          (item) => item.parties.includes(winner2.stepId) && !releasedBarriers.has(item.id)
        );
        if (winnerBarrier2) {
          parkedValues.set(winner2.stepId, winner2.value);
          parked.add(winner2.stepId);
          kernel.trace.emit({
            type: "barrier",
            id: ids.next(winnerBarrier2.id),
            data: { state: "parked", step: winner2.stepId, released: false }
          });
        } else {
          completed.add(winner2.stepId);
          outputs[winner2.stepId] = winner2.value;
        }
        continue;
      }
      const ordered = [];
      const remaining = [...ready];
      while (remaining.length) {
        const pin = runtimeKernel.controls.takeApplicablePin(remaining.map((s) => s.id));
        const chosen = runtimeKernel.scheduler.choose(
          remaining,
          pin ? remaining.findIndex((s) => s.id === pin.choice) : void 0
        );
        ordered.push(chosen);
        remaining.splice(remaining.indexOf(chosen), 1);
        if (!pin) runtimeKernel.controls.append({ type: "pin-interleaving", choice: chosen.id });
        runtimeKernel.trace.emit({
          type: "schedule",
          id: ids.next(chosen.id),
          data: {
            step: chosen.id,
            ready: ready.map((s) => s.id),
            choice: chosen.id,
            controlIndex: Math.max(0, runtimeKernel.controls.consumed() - 1)
          }
        });
      }
      const executableOrdered = ordered;
      const tasks = executableOrdered.map(
        (selected) => Effect3.gen(function* () {
          const id = ids.next(selected.id);
          kernel.trace.emit({ type: "task", id, data: { state: "started", step: selected.id } });
          const owner = `sim:${seed}`;
          journal.claimLease(selected.id, owner);
          let controlledFault;
          let controlledFaultObserved = false;
          const runtime = {
            effect: (name, operation, effectOptions) => {
              const effectId = `${selected.id}:${name}`;
              const idempotencyKey = effectOptions?.idempotencyKey;
              const control = runtimeKernel.controls.takeResolve(effectId) ?? runtimeKernel.controls.takeResolve(name);
              if (control?.outcome === "succeed") {
                kernel.trace.emit({
                  type: "effect",
                  id,
                  data: { name, state: "resolved", controlled: true, ...idempotencyKey ? { idempotencyKey } : {} }
                });
                return Promise.resolve(control.value);
              }
              if (control?.outcome === "fail")
                return Promise.reject(
                  Object.assign(new Error(`effect ${name} failed by control`), {
                    code: "CONTROLLED_EFFECT_FAILURE",
                    details: control
                  })
                );
              if (control?.outcome === "hang") {
                const pending = new Promise(() => void 0);
                cleanup.track({ kind: "mediated-effect", id: effectId }, pending);
                return pending;
              }
              const beforeEffect = faultFor(ast.faults, "effect", "before-task");
              if (beforeEffect) return Promise.reject(faultError(beforeEffect));
              const invoke = () => {
                const pending = settleKernel(Promise.resolve().then(operation), kernel, options.waitBudget ?? 1e4);
                cleanup.track({ kind: "mediated-effect", id: effectId }, pending);
                return pending;
              };
              const run = control?.outcome === "duplicate" ? invoke().then(() => invoke()).then((value2) => {
                recordAmbiguity(
                  ambiguity("duplicate-delivery", {
                    step: selected.id,
                    effect: effectId,
                    before: journal.state(effectId),
                    attempted: "redelivery",
                    winner: "duplicate-delivery",
                    after: journal.state(effectId),
                    transition: "effect-resolved->redelivered",
                    journalState: journal.state(effectId)
                  }),
                  id
                );
                return value2;
              }) : invoke();
              return run.then((value2) => {
                kernel.trace.emit({
                  type: "effect",
                  id,
                  data: { name, state: "requested", ...idempotencyKey ? { idempotencyKey } : {} }
                });
                const duringEffect = faultFor(ast.faults, "effect", "during-task");
                if (duringEffect) throw faultError(duringEffect);
                journal.assertLease(selected.id, owner);
                journal.effectApplied(effectId);
                kernel.trace.emit({
                  type: "durability",
                  id,
                  data: { operation: "effect-applied", effect: effectId, state: journal.state(effectId) }
                });
                const effectFault = (controlledFault?.operation === "effect" && controlledFault.phase === "after-effect-before-journal" ? controlledFault : void 0) ?? faultFor(ast.faults, "effect", "after-effect-before-journal");
                if (effectFault) {
                  recordAmbiguity(
                    ambiguity("effect-applied-journal-missing", {
                      step: selected.id,
                      effect: effectId,
                      before: "none",
                      attempted: "journal-write",
                      winner: "external-effect",
                      after: "effect-applied",
                      transition: "effect-applied->journal-missing",
                      fault: effectFault.id
                    }),
                    id
                  );
                  throw faultError(effectFault);
                }
                applyCutPoint("attempt-write", "before-task", selected.id);
                if (!journal.journal(effectId))
                  throw Object.assign(new Error(`duplicate journal write ${effectId}`), { code: "JOURNAL_DUPLICATE" });
                kernel.trace.emit({
                  type: "durability",
                  id,
                  data: { operation: "journal-write", effect: effectId, state: journal.state(effectId) }
                });
                const ackFault = ((controlledFault?.operation === "effect" || controlledFault?.operation === "attempt-write") && controlledFault.phase === "after-journal-before-ack" ? controlledFault : void 0) ?? faultFor(ast.faults, "effect", "after-journal-before-ack") ?? faultFor(ast.faults, "attempt-write", "after-journal-before-ack");
                if (ackFault) {
                  recordAmbiguity(
                    ambiguity("journal-applied-ack-missing", {
                      step: selected.id,
                      effect: effectId,
                      before: "journaled",
                      attempted: "ack",
                      winner: "journal-write",
                      after: "journaled",
                      transition: "journal-applied->ack-missing",
                      fault: ackFault.id
                    }),
                    id
                  );
                  throw faultError(ackFault);
                }
                journal.ack(effectId);
                kernel.trace.emit({
                  type: "durability",
                  id,
                  data: { operation: "ack", effect: effectId, state: journal.state(effectId) }
                });
                const afterAck = (controlledFault?.operation === "effect" && controlledFault.phase === "after-ack" ? controlledFault : void 0) ?? faultFor(ast.faults, "effect", "after-ack");
                if (afterAck) throw faultError(afterAck);
                kernel.trace.emit({
                  type: "effect",
                  id,
                  data: { name, state: "resolved", ...idempotencyKey ? { idempotencyKey } : {} }
                });
                return value2;
              });
            },
            sleep: (ms) => new Promise((resolve, reject) => {
              const wakeup = `${selected.id}:timer:${ms}`;
              let settled = false;
              const finish = (action) => {
                if (!settled) {
                  settled = true;
                  action();
                }
              };
              journal.registerWakeup(wakeup);
              const eventBefore = faultFor(ast.faults, "event-append", "before-task");
              if (eventBefore) return reject(faultError(eventBefore));
              const lostFault = faultFor(ast.faults, "event-append", "during-task") ?? faultFor(ast.faults, "event-append", "after-task");
              const timer = kernel.clock.sleep(ms, () => {
                const timerId = String(timer);
                const suppliedFire = runtimeKernel.controls.takeTimerFire(timerId);
                const wrongFire = runtimeKernel.controls.peek()?.type === "timer-fire" && !suppliedFire;
                if (wrongFire) {
                  finish(
                    () => reject(
                      Object.assign(
                        new Error(`CONTROL_OUT_OF_ORDER: timer ${timerId} was not the supplied timer target`),
                        {
                          code: "CONTROL_OUT_OF_ORDER",
                          details: { expectedTimer: timerId, supplied: runtimeKernel.controls.peek() }
                        }
                      )
                    )
                  );
                  return;
                }
                if (lostFault) {
                  journal.loseWakeup(wakeup);
                  recordAmbiguity(
                    ambiguity("lost-wakeup", {
                      step: selected.id,
                      wakeup,
                      before: "registered",
                      attempted: "wakeup",
                      winner: "event-loss",
                      after: "lost",
                      transition: "registered->lost",
                      journalState: journal.wakeupState(wakeup)
                    }),
                    id
                  );
                  finish(
                    () => reject(
                      lostFault.phase === "during-task" ? faultError(lostFault) : Object.assign(new Error("lost wakeup"), { code: "LOST_WAKEUP" })
                    )
                  );
                  return;
                }
                journal.deliverWakeup(wakeup);
                if (!suppliedFire) runtimeKernel.controls.append({ type: "timer-fire", timer: timerId });
                kernel.trace.emit({ type: "wait", id, data: { state: "timer-fired", ms, timer: timerId } });
                finish(resolve);
              });
              cleanup.register("virtual-timer", String(timer), () => {
                kernel.clock.cancel(timer);
                finish(
                  () => reject(Object.assign(new Error("task interrupted while sleeping"), { code: "TASK_INTERRUPTED" }))
                );
              });
            }),
            log: (message, data) => kernel.trace.emit({
              type: "task",
              id,
              data: { state: "log", message, ...data === void 0 ? {} : { data } }
            }),
            opaque: (name, operation) => {
              kernel.trace.emit({ type: "opaque-effect", id, data: { name, controllable: false } });
              return Promise.resolve().then(operation);
            }
          };
          let productionValue;
          if (runtimeKernel.controls.peek()?.type === "inject-fault") {
            const control = runtimeKernel.controls.takeNext("inject-fault");
            controlledFault = ast.faults.find((candidate) => candidate.id === control.fault);
            kernel.trace.emit({ type: "fault", id: control.fault, data: control.payload });
          }
          const extensionExecutor = selected.extension ? harness.adapter?.extensionExecutors?.[selected.extension] : void 0;
          if (selected.extension && !extensionExecutor)
            throw Object.assign(new Error(`UNREGISTERED_STEP_EXTENSION: ${selected.extension}`), {
              code: "UNREGISTERED_STEP_EXTENSION",
              details: { step: selected.id, extension: selected.extension }
            });
          if (selected.extension && extensionExecutor)
            yield* Effect3.tryPromise({
              try: () => Promise.resolve(extensionExecutor(selected.id, selected.input)),
              catch: (e) => adapterFailure(harness.adapter, e)
            });
          const runner = options.stepRunners?.[selected.id] ?? stepRunner(selected);
          const barrierBeforeFault = faultFor(ast.faults, "task", "before-task") ?? (harness.kind === "unit-sim" && runner ? faultFor(ast.faults, "resume", "before-task") : void 0);
          if (barrierBeforeFault) throw faultError(barrierBeforeFault);
          const preCallbackBarrier = ast.barriers.find(
            (item) => item.parties.includes(selected.id) && !releasedBarriers.has(item.id)
          );
          const nextControl = runtimeKernel.controls.peek();
          if (preCallbackBarrier) {
            const gate = barrierGate(preCallbackBarrier.id);
            gate.arrived.add(selected.id);
            kernel.trace.emit({
              type: "barrier",
              id: ids.next(preCallbackBarrier.id),
              data: { state: "parked", step: selected.id, released: false, beforeCallback: true }
            });
            const releaseControl = runtimeKernel.controls.peek();
            if (preCallbackBarrier.parties.every((party) => gate.arrived.has(party))) {
              if (releaseControl?.type === "release-barrier" && releaseControl.barrier === preCallbackBarrier.id) {
                runtimeKernel.controls.takeNext("release-barrier");
                releasedBarriers.add(preCallbackBarrier.id);
                kernel.trace.emit({
                  type: "barrier",
                  id: ids.next(preCallbackBarrier.id),
                  data: { state: "released", parties: preCallbackBarrier.parties }
                });
                gate.release();
              } else {
                throw Object.assign(new Error(`barrier ${preCallbackBarrier.id} timed out waiting for release`), {
                  code: "BARRIER_TIMEOUT",
                  details: { barrier: preCallbackBarrier.id, budget: preCallbackBarrier.budget }
                });
              }
            }
            yield* Effect3.tryPromise({ try: () => gate.promise, catch: (cause) => cause });
          }
          const injectFault = harness.adapter?.injectFault;
          const duringFault = ast.faults.find(
            (candidate) => candidate.phase === "during-task" && (candidate.operation === "task" || candidate.operation === "resume" || candidate.operation === "lease" || candidate.operation === "heartbeat" || candidate.operation === "cancellation")
          );
          if (harness.adapter?.runStep && harness.kind !== "unit-sim") {
            const productionOperation = harness.kind === "e2e-real-process" ? "runWorkflow" : selected.id;
            const canonicalOperation = productionOperation.replace(/#\d+$/, "");
            const mappedOperation = harness.kind === "integration-real-db" ? dbOperationKind(productionOperation) : harness.kind === "e2e-real-process" ? processOperationKind(productionOperation) : void 0;
            const fireAtTransition = (candidate, invoked, observedResult) => Effect3.gen(function* () {
              if (controlledFault?.id === candidate.id) controlledFaultObserved = true;
              const observation = injectFault ? yield* Effect3.tryPromise({
                try: () => Promise.resolve(
                  injectFault(candidate, {
                    operation: mappedOperation,
                    phase: candidate.phase,
                    stepId: selected.id,
                    input: selected.input,
                    invoked,
                    result: observedResult
                  })
                ),
                catch: (e) => adapterFailure(harness.adapter, e)
              }) : void 0;
              kernel.trace.emit({
                type: "durability",
                id: ids.next(`${candidate.operation}:${candidate.phase}`),
                data: {
                  operation: candidate.operation,
                  phase: candidate.phase,
                  receipt: {
                    stepId: selected.id,
                    faultId: candidate.id,
                    productionOperation: canonicalOperation,
                    invoked,
                    adapter: harness.adapter.identity,
                    observation
                  }
                }
              });
              return observation;
            });
            const transitionFault = (phase) => mappedOperation ? faultFor(ast.faults, mappedOperation, phase) : void 0;
            const beforeTransition = transitionFault("before-task");
            if (beforeTransition) {
              yield* fireAtTransition(beforeTransition, false, void 0);
              throw faultError(beforeTransition);
            }
            productionValue = yield* Effect3.tryPromise({
              try: () => Promise.resolve(harness.adapter.runStep(productionOperation, selected.input)),
              catch: (e) => adapterFailure(harness.adapter, e)
            });
            kernel.trace.emit({
              type: "adapter",
              id,
              data: { identity: harness.adapter.identity, step: selected.id, executed: true }
            });
            if (canonicalOperation === "claimAttemptCompletion" && productionValue === false) {
              const input = selected.input;
              recordAmbiguity(
                ambiguity(input?.runtimeOwnerId === "old-owner" ? "lease-lost" : "duplicate-delivery", {
                  step: selected.id,
                  before: "in-progress",
                  attempted: "completion-cas",
                  winner: "existing-owner-or-prior-completion",
                  after: "unchanged",
                  observed: false,
                  transition: "completion-cas-rejected"
                }),
                id
              );
            }
            const duringTransitionFault = transitionFault("during-task");
            if (duringTransitionFault) {
              const rawReceipt = yield* fireAtTransition(duringTransitionFault, true, productionValue);
              if (harness.kind === "e2e-real-process") {
                const observation = rawReceipt;
                if (observation?.terminatedBy !== "SIGKILL" || observation.resumed !== true)
                  throw faultError(duringTransitionFault);
                recordAmbiguity(
                  ambiguity("restart-in-task", {
                    step: selected.id,
                    source: "real-process-observation",
                    terminatedBy: observation.terminatedBy,
                    resumedStatus: observation.resumedStatus,
                    resumedOutputPersisted: observation.resumedOutputPersisted === true
                  }),
                  id
                );
                if (observation.preKillEffectApplied && !observation.journalWritten)
                  recordAmbiguity(
                    ambiguity("effect-applied-journal-missing", {
                      step: selected.id,
                      source: "real-process-observation",
                      preKillEffectApplied: true,
                      journalWritten: false,
                      outputPersisted: observation.outputPersisted,
                      resumedOutputPersisted: observation.resumedOutputPersisted === true
                    }),
                    id
                  );
              } else {
                const transitionReceipt = rawReceipt;
                const takeover = transitionReceipt?.observed?.leaseTakeover;
                if (mappedOperation === "heartbeat" && takeover?.executed === true && takeover.oldOwnerHeartbeatRejected === true) {
                  recordAmbiguity(
                    ambiguity("lease-lost", {
                      step: selected.id,
                      source: "real-db-observation",
                      attempted: "heartbeat",
                      winner: "lease-takeover",
                      before: "owned",
                      after: "fenced",
                      transition: "owned->fenced",
                      previousOwner: takeover.previousOwner ?? null,
                      fencingOwner: takeover.fencingOwner ?? null,
                      observed: takeover.after
                    }),
                    id
                  );
                }
                const race = transitionReceipt?.observed?.cancellationRace;
                if (mappedOperation === "cancellation" && race?.executed === true && race.cancelRequested === true && race.completionRejected === true) {
                  recordAmbiguity(
                    ambiguity("cancellation-race", {
                      step: selected.id,
                      source: "real-db-observation",
                      attempted: "completion-cas",
                      winner: "cancellation",
                      transition: "cancel-requested->completion-fenced",
                      observed: race.after
                    }),
                    id
                  );
                }
                throw faultError(duringTransitionFault);
              }
            }
            const ackTransitionFault = transitionFault("after-journal-before-ack");
            if (ackTransitionFault && (mappedOperation !== "completion-cas" || productionValue === true)) {
              const ackReceipt = yield* fireAtTransition(ackTransitionFault, true, productionValue);
              recordAmbiguity(
                ambiguity("journal-applied-ack-missing", {
                  step: selected.id,
                  source: "real-db-observation",
                  before: "in-progress",
                  attempted: "ack",
                  winner: "journal-write",
                  after: "journaled",
                  observed: productionValue === true,
                  durable: ackReceipt?.observed ?? null,
                  transition: "journal-applied->ack-missing",
                  fault: ackTransitionFault.id
                }),
                id
              );
              throw faultError(ackTransitionFault);
            }
            const afterTransitionFault = transitionFault("after-task");
            if (afterTransitionFault) {
              yield* fireAtTransition(afterTransitionFault, true, productionValue);
              throw faultError(afterTransitionFault);
            }
          }
          if (runtimeKernel.controls.peek()?.type === "cancel") {
            const cancel = runtimeKernel.controls.takeNext("cancel");
            recordAmbiguity(
              ambiguity("cancellation-race", {
                step: selected.id,
                reason: cancel.reason ?? "cancelled",
                transition: "task-started->cancelled"
              }),
              id
            );
            throw Object.assign(new Error(cancel.reason ?? "scenario cancelled"), { code: "SCENARIO_CANCELLED" });
          }
          if (controlledFault?.operation === "task" && controlledFault.phase === "during-task") {
            throw faultError(controlledFault);
          }
          if (runner)
            kernel.trace.emit({
              type: "opaque-effect",
              id,
              data: { name: `step:${selected.id}`, controllable: false }
            });
          let value;
          const runTask = () => {
            let returned;
            try {
              returned = runner(runtime, selected.input);
            } catch (cause) {
              return Promise.reject(cause);
            }
            const pending = Promise.resolve(returned);
            cleanup.track({ kind: "task-fiber", id: selected.id }, pending);
            return pending;
          };
          if (runner && duringFault && harness.kind === "unit-sim") {
            const child = yield* Effect3.forkChild(Effect3.tryPromise({ try: () => runTask(), catch: (e) => e }));
            yield* Effect3.yieldNow;
            yield* Effect3.tryPromise({ try: () => Promise.resolve(), catch: (cause) => cause });
            const completedExit = child.pollUnsafe();
            if (completedExit !== void 0) {
              value = yield* Fiber3.join(child);
            } else {
              yield* Fiber3.interrupt(child);
              if (duringFault.operation === "resume") {
                if (controlledFault?.id === duringFault.id) controlledFaultObserved = true;
                recordAmbiguity(
                  ambiguity("restart-in-task", {
                    step: selected.id,
                    transition: "running->killed->restarted",
                    winner: "resume"
                  }),
                  id
                );
                value = yield* Effect3.tryPromise({ try: () => runTask(), catch: (e) => e });
              } else {
                if (duringFault.operation === "lease" || duringFault.operation === "heartbeat" || duringFault.operation === "cancellation")
                  journal.loseLease(selected.id);
                if (duringFault.operation === "cancellation")
                  recordAmbiguity(
                    ambiguity("cancellation-race", {
                      step: selected.id,
                      transition: "running->cancelled",
                      attempted: "cancellation",
                      winner: "cancellation",
                      before: "owned",
                      after: "cancelled"
                    }),
                    id
                  );
                if (duringFault.operation === "lease" || duringFault.operation === "heartbeat")
                  recordAmbiguity(
                    ambiguity("lease-lost", {
                      step: selected.id,
                      transition: "owned->fenced",
                      attempted: "lease-takeover",
                      winner: "lease-takeover",
                      before: "owned",
                      after: "fenced"
                    }),
                    id
                  );
                throw faultError(duringFault);
              }
            }
          }
          if (runner && !duringFault) value = yield* Effect3.tryPromise({ try: () => runTask(), catch: (e) => e });
          if (runtimeKernel.controls.peek()?.type === "cancel") {
            const cancel = runtimeKernel.controls.takeNext("cancel");
            recordAmbiguity(
              ambiguity("cancellation-race", {
                step: selected.id,
                reason: cancel.reason ?? "cancelled",
                transition: "task-completed->cancelled"
              }),
              id
            );
            throw Object.assign(new Error(cancel.reason ?? "scenario cancelled"), { code: "SCENARIO_CANCELLED" });
          }
          const pendingControl = runtimeKernel.controls.peek();
          if (pendingControl?.type === "task-restart" && pendingControl.step === selected.id) {
            runtimeKernel.controls.takeNext("task-restart");
            recordAmbiguity(
              ambiguity("restart-in-task", {
                step: selected.id,
                before: "completed",
                attempted: "resume",
                winner: "resume",
                after: "running",
                transition: "task-completed->restarted"
              }),
              id
            );
            if (runner) value = yield* Effect3.tryPromise({ try: () => runTask(), catch: (e) => e });
          }
          const after = faultFor(ast.faults, "task", "after-task");
          if (harness.kind === "unit-sim" && runner) simulatedCompletionTransition(selected.id, id);
          if (after) {
            throw faultError(after);
          }
          if (controlledFault && !controlledFaultObserved) {
            throw Object.assign(
              new Error(
                `CONTROL_UNCONSUMED: inject-fault ${controlledFault.id} armed ${controlledFault.operation}:${controlledFault.phase} but the operation never transitioned`
              ),
              {
                code: "CONTROL_UNCONSUMED",
                details: {
                  fault: controlledFault.id,
                  operation: controlledFault.operation,
                  phase: controlledFault.phase
                }
              }
            );
          }
          const finalValue = harness.kind === "unit-sim" ? value : productionValue;
          const rendezvous = ast.barriers.find(
            (item) => item.parties.includes(selected.id) && !releasedBarriers.has(item.id)
          );
          if (rendezvous) {
            kernel.trace.emit({
              type: "barrier",
              id: ids.next(rendezvous.id),
              data: { state: "parked", step: selected.id, released: false, beforeCompletion: true }
            });
          } else {
            kernel.trace.emit({
              type: "task",
              id,
              data: {
                state: "finished",
                step: selected.id,
                resultDigest: canonicalize(finalValue === void 0 ? null : finalValue)
              }
            });
          }
          return finalValue;
        })
      );
      for (const selected of executableOrdered) activeTaskIds.add(selected.id);
      const winner = yield* runtimeKernel.executor.runReadySet(
        tasks.map((effect, index) => ({
          stepId: executableOrdered[index].id,
          effect
        }))
      );
      activeTaskIds.delete(winner.stepId);
      const winnerBarrier = ast.barriers.find(
        (item) => item.parties.includes(winner.stepId) && !releasedBarriers.has(item.id)
      );
      if (winnerBarrier) {
        parkedValues.set(winner.stepId, winner.value);
        parked.add(winner.stepId);
        kernel.trace.emit({
          type: "barrier",
          id: ids.next(winnerBarrier.id),
          data: { state: "parked", step: winner.stepId, released: false }
        });
      } else {
        outputs[winner.stepId] = winner.value;
        completed.add(winner.stepId);
      }
    }
    for (const item of ast.barriers) {
      const pendingRelease = kernel.controls.peek();
      const release = pendingRelease?.type === "release-barrier" && pendingRelease.barrier === item.id ? kernel.controls.takeNext("release-barrier") : void 0;
      const released = release?.barrier === item.id || releasedBarriers.has(item.id);
      if (!released)
        throw Object.assign(new Error(`barrier ${item.id} timed out waiting for release`), {
          code: "BARRIER_TIMEOUT",
          details: { barrier: item.id, budget: item.budget }
        });
      kernel.trace.emit({ type: "barrier", id: item.id, data: { state: "released", parties: item.parties } });
    }
    const leftover = runtimeKernel.controls.pendingControls();
    if (leftover.length)
      throw Object.assign(new Error(`CONTROL_UNCONSUMED: ${leftover.map((control) => control.type).join(", ")}`), {
        code: "CONTROL_UNCONSUMED",
        details: { controls: leftover }
      });
    return outputs;
  });
  const execution = runAtBoundaryFork(program.pipe(Effect3.provide(kernelLayer(kernel))));
  let result;
  try {
    if (harness.kind === "unit-sim")
      result = await settleKernel(execution.promise, kernel, options.waitBudget ?? 1e4);
    else {
      let deadlineTimer;
      try {
        result = await Promise.race([
          execution.promise,
          new Promise((_, reject) => {
            deadlineTimer = setTimeout(
              () => reject(
                Object.assign(new Error("BOUNDED_WAIT_EXHAUSTED: real harness did not settle"), {
                  code: "BOUNDED_WAIT_EXHAUSTED"
                })
              ),
              Math.max(1, options.waitBudget ?? 1e4)
            );
          })
        ]);
      } finally {
        if (deadlineTimer !== void 0) clearTimeout(deadlineTimer);
      }
    }
  } catch (cause) {
    await execution.interrupt();
    result = {
      ok: false,
      error: {
        name: "BoundedWaitError",
        code: cause.code ?? "BOUNDED_WAIT_EXHAUSTED",
        message: String(cause)
      }
    };
  }
  let cleanupFailure;
  try {
    await cleanup.close(options.cleanupBudget ?? 100);
  } catch (cause) {
    cleanupFailure = cause;
  }
  try {
    assertNoLeaks(
      cleanup,
      kernel.clock.pending().map((timer) => ({ kind: "virtual-timer", id: String(timer.id) }))
    );
  } catch (cause) {
    cleanupFailure ??= cause;
  }
  if (cleanupFailure) {
    const primary = result.ok ? void 0 : result.error;
    const cleanupCode = cleanupFailure.code === "CLEANUP_LEAK" ? "CLEANUP_LEAK" : "CLEANUP_FAILED";
    result = {
      ok: false,
      error: {
        name: cleanupCode === "CLEANUP_LEAK" ? "CleanupLeakError" : "CleanupError",
        code: cleanupCode,
        message: String(cleanupFailure.message),
        cause: primary,
        details: { primary, cleanup: cleanupFailure }
      }
    };
  }
  if (kernel.trace.snapshot().some((event) => event.type === "opaque-effect")) residues.add("unmediated-opaque-effect");
  const finalControlLog = kernel.controls.log();
  const identityControls = kernel.controls.pendingControls().length ? replayControls : finalControlLog;
  const finalBase = {
    ...base,
    controlLog: finalControlLog,
    replayIdentity: replayIdentity({ ast, seed, controlLog: identityControls }),
    ambiguity: ambiguities,
    determinismReport: { deterministic: residues.size === 0, residues: [...residues] }
  };
  if (!result.ok && result.error.code === "ADMISSION_FAILED") {
    const kind = harness.kind === "e2e-real-process" ? "real-process" : "real-db";
    const skippedAdmission = harness.config.policy === "skip";
    return {
      ...finalBase,
      status: skippedAdmission ? "capability-skip" : "capability-failure",
      outputs,
      trace: kernel.trace.snapshot(),
      capabilityReport: [
        ...capabilityReport,
        {
          kind: skippedAdmission ? "capability-skip" : "capability-failure",
          harness: harness.name,
          capability: kind,
          hint: result.error.message
        }
      ],
      error: result.error
    };
  }
  return result.ok ? { ...finalBase, status: "finished", outputs: result.value, trace: kernel.trace.snapshot() } : { ...finalBase, status: "failed", outputs, trace: kernel.trace.snapshot(), error: result.error };
};
async function runScenario(arg, options) {
  if (arg && typeof arg === "object" && "workflow" in arg) {
    return runWorkflowScenario(arg);
  }
  return runKernelScenario(arg, options ?? {});
}
export {
  runKernelScenario,
  runScenario,
  runWorkflowScenario
};
