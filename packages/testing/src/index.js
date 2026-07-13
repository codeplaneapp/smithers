var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/scenario/ast.ts
var freezeScenario;
var init_ast = __esm({
  "src/scenario/ast.ts"() {
    "use strict";
    freezeScenario = (value) => {
      for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freezeScenario(child);
      return Object.freeze(value);
    };
  }
});

// src/scenario/builder.ts
import { createHash } from "crypto";
var runners, runnersByBinding, runnerOwners, nextAnonymousRunner, stepRunner, step, barrier, fault, extension, scenario;
var init_builder = __esm({
  "src/scenario/builder.ts"() {
    "use strict";
    init_ast();
    runners = /* @__PURE__ */ new WeakMap();
    runnersByBinding = /* @__PURE__ */ new Map();
    runnerOwners = /* @__PURE__ */ new Map();
    nextAnonymousRunner = 0;
    stepRunner = (stepValue) => runners.get(stepValue) ?? (stepValue.runnerBinding ? runnersByBinding.get(stepValue.runnerBinding) : void 0);
    step = (id, options = {}) => {
      const runnerBinding = options.run ? options.runnerBinding ?? `anonymous:${nextAnonymousRunner++}:${createHash("sha256").update(Function.prototype.toString.call(options.run)).digest("hex").slice(0, 16)}` : options.runnerBinding;
      if (options.run && runnerBinding) {
        const owner = runnerOwners.get(runnerBinding);
        if (owner && owner !== options.run) throw new Error(`RUNNER_BINDING_COLLISION: ${runnerBinding} is already bound to another runner`);
        runnerOwners.set(runnerBinding, options.run);
      }
      const value = freezeScenario({ kind: "step", id, ...options.input === void 0 ? {} : { input: options.input }, dependsOn: [...options.dependsOn ?? []], capabilities: [...options.capabilities ?? []], ...options.extension ? { extension: options.extension } : {}, ...runnerBinding ? { runnerBinding } : {} });
      if (options.run) {
        runners.set(value, options.run);
        if (runnerBinding) runnersByBinding.set(runnerBinding, options.run);
      }
      return value;
    };
    barrier = (id, parties, budget = 100) => freezeScenario({ kind: "barrier", id, parties: [...parties], budget });
    fault = (id, phase, operation, outcome) => freezeScenario({ kind: "fault", id, phase, operation, ...outcome === void 0 ? {} : { outcome } });
    extension = (name, value) => freezeScenario({ kind: "extension", name, value });
    scenario = (name, options = {}) => freezeScenario({ version: 1, name, ...options.seed === void 0 ? {} : { seed: options.seed }, steps: [...options.steps ?? []], barriers: [...options.barriers ?? []], faults: [...options.faults ?? []], extensions: [...options.extensions ?? []] });
  }
});

// src/harness/capabilities.ts
var admitCapabilities, requiredCapabilities;
var init_capabilities = __esm({
  "src/harness/capabilities.ts"() {
    "use strict";
    admitCapabilities = (harness, requested, policy = "fail") => requested.map((capability) => harness.capabilities.has(capability) ? { kind: "supported", harness: harness.name, capability } : { kind: policy === "skip" ? "capability-skip" : "capability-failure", harness: harness.name, capability, hint: "Choose a harness that declares this capability." });
    requiredCapabilities = (ast) => {
      const result = /* @__PURE__ */ new Set();
      for (const step2 of ast.steps) for (const capability of step2.capabilities) result.add(capability);
      if (ast.barriers.length) result.add("barriers");
      if (ast.faults.length) result.add("durability-faults");
      if (ast.extensions.length) result.add("explicit-interleaving");
      return [...result];
    };
  }
});

// src/scenario/compile.ts
var validPairs, compileScenario;
var init_compile = __esm({
  "src/scenario/compile.ts"() {
    "use strict";
    init_capabilities();
    validPairs = /* @__PURE__ */ new Set([
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
    compileScenario = (ast, registeredExtensions = /* @__PURE__ */ new Set()) => {
      const diagnostics = [];
      const ids = /* @__PURE__ */ new Set();
      for (const step2 of ast.steps) {
        if (ids.has(step2.id)) diagnostics.push({ code: "DUPLICATE_STEP_ID", message: `duplicate step id ${step2.id}`, node: step2.id });
        ids.add(step2.id);
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
          if (!graph.has(dep)) diagnostics.push({ code: "UNKNOWN_DEPENDENCY", message: `${id} depends on unknown step ${dep}`, node: id });
          else visit(dep);
        }
        visiting.delete(id);
        visited.add(id);
      };
      for (const id of ids) visit(id);
      const barriers = new Set(ast.barriers.map((b) => b.id));
      for (const b of ast.barriers) {
        if (!Number.isInteger(b.budget) || b.budget < 1) diagnostics.push({ code: "INVALID_BARRIER_BUDGET", message: `barrier ${b.id} has invalid budget`, node: b.id });
        for (const party of b.parties) if (!ids.has(party)) diagnostics.push({ code: "UNKNOWN_BARRIER_PARTY", message: `barrier ${b.id} names unknown step ${party}`, node: b.id });
        if (barriers.has(b.id) && ast.barriers.indexOf(b) !== ast.barriers.findIndex((x) => x.id === b.id)) diagnostics.push({ code: "DUPLICATE_BARRIER_ID", message: `duplicate barrier id ${b.id}`, node: b.id });
      }
      for (const f of ast.faults) if (!validPairs.has(`${f.operation}:${f.phase}`) && !(f.operation === "task" && ["before-task", "during-task", "after-task"].includes(f.phase))) diagnostics.push({ code: "UNSUPPORTED_FAULT_CUT_POINT", message: `fault ${f.id} cannot target ${f.operation} at ${f.phase}`, node: f.id });
      for (const ext of ast.extensions) if (!registeredExtensions.has(ext.name)) diagnostics.push({ code: "UNREGISTERED_EXTENSION", message: `extension ${ext.name} has no executor`, node: ext.name });
      for (const step2 of ast.steps) if (step2.extension && !registeredExtensions.has(step2.extension)) diagnostics.push({ code: "UNREGISTERED_STEP_EXTENSION", message: `step ${step2.id} references extension ${step2.extension} with no executor`, node: step2.id });
      return diagnostics.length ? { ok: false, diagnostics, requiredCapabilities: requiredCapabilities(ast) } : { ok: true, requiredCapabilities: requiredCapabilities(ast) };
    };
  }
});

// src/scenario/canonicalize.ts
var CanonicalizeError, encode, canonicalize;
var init_canonicalize = __esm({
  "src/scenario/canonicalize.ts"() {
    "use strict";
    CanonicalizeError = class extends Error {
      constructor(message, details) {
        super(message);
        this.details = details;
        this.name = "CanonicalizeError";
      }
      details;
      code = "CANONICALIZE_UNSUPPORTED";
    };
    encode = (value, path = "$", seen = /* @__PURE__ */ new Set()) => {
      if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new CanonicalizeError("Unsupported value at " + path);
        return JSON.stringify(value);
      }
      if (typeof value !== "object") throw new CanonicalizeError("Unsupported value at " + path);
      if (seen.has(value)) throw new CanonicalizeError("Circular value at " + path);
      seen.add(value);
      const result = Array.isArray(value) ? "[" + value.map((item, i) => encode(item, path + "[" + i + "]", seen)).join(",") + "]" : "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + encode(value[key], path + "." + key, seen)).join(",") + "}";
      seen.delete(value);
      return result;
    };
    canonicalize = (value) => encode(value);
  }
});

// src/scenario/replayIdentity.ts
import { createHash as createHash2 } from "crypto";
var replayIdentity;
var init_replayIdentity = __esm({
  "src/scenario/replayIdentity.ts"() {
    "use strict";
    init_canonicalize();
    replayIdentity = (input) => "ri1:" + createHash2("sha256").update(canonicalize({ ast: input.ast, seed: input.seed, controlLog: input.controlLog ?? [] })).digest("hex");
  }
});

// src/kernel/VirtualClock.ts
var VirtualClock;
var init_VirtualClock = __esm({
  "src/kernel/VirtualClock.ts"() {
    "use strict";
    VirtualClock = class {
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
            if (++steps > limit) throw Object.assign(new Error("VIRTUAL_TIME_BUDGET_EXHAUSTED: virtual-time callback budget exhausted"), { code: "VIRTUAL_TIME_BUDGET_EXHAUSTED", details: { limit, now: this.current } });
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
          if (++steps > 1e4) throw Object.assign(new Error("virtual-time callback budget exhausted"), { code: "VIRTUAL_TIME_BUDGET_EXHAUSTED" });
          this.timers.shift()?.callback();
        }
      }
    };
  }
});

// src/kernel/SeededScheduler.ts
var SeededScheduler;
var init_SeededScheduler = __esm({
  "src/kernel/SeededScheduler.ts"() {
    "use strict";
    SeededScheduler = class {
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
  }
});

// src/kernel/ControlBus.ts
var ControlBus;
var init_ControlBus = __esm({
  "src/kernel/ControlBus.ts"() {
    "use strict";
    ControlBus = class {
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
      log() {
        return [...this.observed, ...this.pending];
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
      consumed() {
        return this.observed.length;
      }
      pendingControls() {
        return [...this.pending];
      }
    };
  }
});

// src/kernel/TraceCollector.ts
var TraceCollector;
var init_TraceCollector = __esm({
  "src/kernel/TraceCollector.ts"() {
    "use strict";
    TraceCollector = class {
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
  }
});

// src/harness/Harness.ts
var trustedAdapters, registerTrustedAdapter, trustedAdapterKind, makeHarness, unitSimHarness, integrationHarness, e2eHarness;
var init_Harness = __esm({
  "src/harness/Harness.ts"() {
    "use strict";
    init_capabilities();
    trustedAdapters = /* @__PURE__ */ new WeakMap();
    registerTrustedAdapter = (adapter, kind) => {
      trustedAdapters.set(adapter, kind);
      return adapter;
    };
    trustedAdapterKind = (adapter) => trustedAdapters.get(adapter);
    makeHarness = (kind, config = {}) => {
      const defaults = { "unit-sim": ["virtual-time", "seeded-interleaving", "explicit-interleaving", "barriers", "mediated-effects", "durability-faults"], "integration-real-db": ["virtual-time", "seeded-interleaving", "explicit-interleaving", "barriers", "mediated-effects", "real-db", "native-error-parity", "durability-faults"], "e2e-real-process": ["real-process", "native-error-parity", "durability-faults"] };
      const requestedCapabilities = config.capabilities ?? defaults[kind];
      const forbiddenForUnit = /* @__PURE__ */ new Set(["real-db", "real-process", "native-error-parity"]);
      const capabilities = new Set(kind === "unit-sim" ? requestedCapabilities.filter((capability) => !forbiddenForUnit.has(capability)) : requestedCapabilities);
      const name = config.name ?? kind;
      const admit = (requested) => {
        const decisions = admitCapabilities({ name, capabilities }, requested, config.policy ?? "fail");
        const forbidden = requested.filter((capability) => forbiddenForUnit.has(capability));
        if (kind === "unit-sim" && forbidden.length) return [...decisions, ...forbidden.map((capability) => ({ kind: config.policy === "skip" ? "capability-skip" : "capability-failure", harness: name, capability, hint: "unit-sim cannot claim a real production capability" }))];
        const crossKind = requestedCapabilities.some((capability) => kind === "integration-real-db" && capability === "real-process" || kind === "e2e-real-process" && capability === "real-db");
        if (kind !== "unit-sim" && (crossKind || !config.adapter || trustedAdapterKind(config.adapter) !== kind || typeof config.adapter.admissionProbe !== "function" || typeof config.adapter.runStep !== "function" || !config.adapter.verifiedProductionIdentity)) {
          const capability = kind === "e2e-real-process" ? "real-process" : "real-db";
          return [...decisions, { kind: config.policy === "skip" ? "capability-skip" : "capability-failure", harness: name, capability, hint: "declaration is not proof: a verified production adapter with admissionProbe, runStep, and identity is required" }];
        }
        return decisions;
      };
      return { name, kind, capabilities, config, adapter: config.adapter, admit, admitScenario: (ast, requested = []) => admit([...requiredCapabilities(ast), ...requested]) };
    };
    unitSimHarness = (config = {}) => makeHarness("unit-sim", config);
    integrationHarness = (config = {}) => makeHarness("integration-real-db", config);
    e2eHarness = (config = {}) => makeHarness("e2e-real-process", config);
  }
});

// src/kernel/boundary.ts
import { Cause, Effect as Effect2, Exit, Fiber, Option } from "effect";
var toHarnessError, runAtBoundaryFork;
var init_boundary = __esm({
  "src/kernel/boundary.ts"() {
    "use strict";
    toHarnessError = (error) => {
      if (error && typeof error === "object") {
        const value = error;
        return { name: String(value.name ?? error.constructor?.name ?? "Error"), code: String(value.code ?? "HARNESS_ERROR"), message: String(value.message ?? error), ...value.fidelity === "simulation" || value.fidelity === "native" ? { fidelity: value.fidelity } : {}, ...typeof value.tag === "string" ? { tag: value.tag } : {}, ...typeof value.summary === "string" ? { summary: value.summary } : {}, ...typeof value.docsUrl === "string" ? { docsUrl: value.docsUrl } : {}, ...value.serialized === void 0 ? {} : { serialized: value.serialized }, ...value.details === void 0 ? {} : { details: value.details }, ...value.cause === void 0 ? {} : { cause: toHarnessError(value.cause) } };
      }
      return { name: "Error", code: "HARNESS_ERROR", message: String(error) };
    };
    runAtBoundaryFork = (program) => {
      const fiber = Effect2.runFork(Effect2.exit(program));
      const promise = Effect2.runPromise(Fiber.join(fiber)).then((exit) => {
        if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
        const cause = Option.getOrElse(Cause.failureOption(exit.cause), () => Option.getOrElse(Cause.dieOption(exit.cause), () => new Error("kernel program failed")));
        return { ok: false, error: toHarnessError(cause) };
      });
      return { promise, interrupt: () => Effect2.runPromise(Fiber.interrupt(fiber)) };
    };
  }
});

// src/kernel/KernelRuntime.ts
import { Context, Effect as Effect3, Fiber as Fiber2, Layer } from "effect";
var KernelRuntimeService, kernelLayer, makeKernel;
var init_KernelRuntime = __esm({
  "src/kernel/KernelRuntime.ts"() {
    "use strict";
    init_ControlBus();
    init_SeededScheduler();
    init_TraceCollector();
    init_VirtualClock();
    KernelRuntimeService = class extends Context.Tag("@smithers/testing/KernelRuntime")() {
    };
    kernelLayer = (kernel) => Layer.succeed(KernelRuntimeService, kernel);
    makeKernel = (seed, controls = []) => {
      const clock = new VirtualClock();
      const bus = new ControlBus(controls);
      const runtime = { clock, scheduler: new SeededScheduler(seed), controls: bus, trace: new TraceCollector(clock) };
      const active = /* @__PURE__ */ new Map();
      const executor = Object.freeze({
        // This is the kernel's scheduling boundary. Ready tasks are Effect values,
        // forked and raced by the Effect runtime; the public runner never owns the
        // task fibers or implements a Promise race itself.
        runReadySet: (tasks) => Effect3.gen(function* () {
          for (const { stepId, effect } of tasks) if (!active.has(stepId)) active.set(stepId, yield* Effect3.fork(effect));
          const winner = yield* Effect3.raceAll([...active.entries()].map(([stepId, fiber]) => Fiber2.join(fiber).pipe(Effect3.map((value) => ({ stepId, value })))));
          active.delete(winner.stepId);
          return winner;
        })
      });
      return Object.freeze({ ...runtime, executor });
    };
  }
});

// src/internal/deterministicIds.ts
var mix, deterministicIds;
var init_deterministicIds = __esm({
  "src/internal/deterministicIds.ts"() {
    "use strict";
    mix = (value) => {
      value = Math.imul(value ^ value >>> 16, 73244475);
      value = Math.imul(value ^ value >>> 16, 73244475);
      return (value ^ value >>> 16) >>> 0;
    };
    deterministicIds = (seed) => {
      let state = mix(seed >>> 0);
      return { next: (prefix = "id") => {
        state = mix(state + 2654435769);
        return prefix + "-" + state.toString(36).padStart(7, "0");
      }, snapshot: () => state };
    };
  }
});

// src/cleanup/CleanupScope.ts
var CleanupScope;
var init_CleanupScope = __esm({
  "src/cleanup/CleanupScope.ts"() {
    "use strict";
    CleanupScope = class {
      entries = [];
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
                  timer = setTimeout(() => reject(Object.assign(new Error(`cleanup timed out: ${entry.resource.kind}/${entry.resource.id}`), { code: "CLEANUP_TIMEOUT" })), Math.max(0, deadline - Date.now()));
                })
              ]);
              disposed = true;
            } finally {
              if (timer !== void 0) clearTimeout(timer);
            }
          } catch (cause) {
            error ??= Object.assign(new Error(`CLEANUP_FAILED: ${entry.resource.kind}/${entry.resource.id}`), { code: "CLEANUP_FAILED", cause });
          }
          if (!disposed) failed.push(entry);
        }
        this.entries.push(...failed.reverse());
        if (error) throw error;
      }
    };
  }
});

// src/cleanup/leakAssertions.ts
var assertNoLeaks;
var init_leakAssertions = __esm({
  "src/cleanup/leakAssertions.ts"() {
    "use strict";
    assertNoLeaks = (scope, extra = []) => {
      const leaks = [...scope.pending(), ...extra];
      if (leaks.length) throw Object.assign(new Error(`CLEANUP_LEAK: ${leaks.map((x) => `${x.kind}/${x.id}`).join(", ")}`), { code: "CLEANUP_LEAK", details: { leaks } });
    };
  }
});

// src/durability/journalModel.ts
var JournalModel;
var init_journalModel = __esm({
  "src/durability/journalModel.ts"() {
    "use strict";
    JournalModel = class {
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
        if (this.state(id) !== "journaled") throw Object.assign(new Error(`cannot ack unjournaled effect ${id}`), { code: "JOURNAL_ACK_WITHOUT_WRITE" });
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
        if (this.leaseState(id) !== "owned" || this.owners.get(id) !== owner) throw Object.assign(new Error(`lease fenced for ${id}`), { code: "LEASE_FENCED", details: { id, owner, currentOwner: this.owners.get(id) } });
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
        return { journal: Object.fromEntries(this.states), leases: Object.fromEntries(this.leases), wakeups: Object.fromEntries(this.wakeups) };
      }
    };
  }
});

// src/durability/ambiguity.ts
var ambiguity;
var init_ambiguity = __esm({
  "src/durability/ambiguity.ts"() {
    "use strict";
    ambiguity = (outcome, details = {}) => Object.freeze({ outcome, guaranteed: outcome === "journal-applied-ack-missing" ? "journal-cas-only" : "at-least-once", details: Object.freeze({ ...details }) });
  }
});

// src/runScenario.ts
var runScenario_exports = {};
__export(runScenario_exports, {
  runScenario: () => runScenario
});
import { Effect as Effect4, Fiber as Fiber3 } from "effect";
var faultFor, faultAt, faultError, ambiguityFor, settleKernel, runScenario;
var init_runScenario = __esm({
  "src/runScenario.ts"() {
    "use strict";
    init_replayIdentity();
    init_KernelRuntime();
    init_boundary();
    init_deterministicIds();
    init_Harness();
    init_compile();
    init_builder();
    init_CleanupScope();
    init_leakAssertions();
    init_journalModel();
    init_ambiguity();
    faultFor = (faults, operation, phase) => faults.find((fault2) => fault2.operation === operation && fault2.phase === phase);
    faultAt = (faults, phase) => faults.find((fault2) => fault2.phase === phase);
    faultError = (fault2) => Object.assign(new Error(`fault injected at ${fault2.id}`), { code: "DURABILITY_FAULT_INJECTED", details: fault2, fidelity: "simulation" });
    ambiguityFor = (fault2, step2, effect, observed = true) => {
      if ((fault2.operation === "event-append" || fault2.operation === "completion-cas") && !observed) return void 0;
      const outcome = fault2.phase === "after-effect-before-journal" ? "effect-applied-journal-missing" : fault2.phase === "after-journal-before-ack" ? "journal-applied-ack-missing" : fault2.operation === "lease" || fault2.operation === "heartbeat" ? "lease-lost" : fault2.operation === "cancellation" ? "cancellation-race" : fault2.operation === "resume" ? "restart-in-task" : fault2.operation === "event-append" ? "lost-wakeup" : fault2.operation === "completion-cas" ? "duplicate-delivery" : void 0;
      return outcome ? ambiguity(outcome, { step: step2, effect, fault: fault2.id }) : void 0;
    };
    settleKernel = async (promise, kernel, budget) => {
      let done = false;
      let value;
      let error;
      void promise.then((v) => {
        done = true;
        value = v;
      }, (e) => {
        done = true;
        error = e;
      });
      for (let turn = 0; !done && turn < budget; turn++) {
        for (let microtask = 0; microtask < 4; microtask++) await Promise.resolve();
        if (!done && kernel.clock.pending().length) kernel.clock.advanceToNextTimer();
      }
      if (!done) throw Object.assign(new Error("BOUNDED_WAIT_EXHAUSTED: kernel did not settle"), { code: "BOUNDED_WAIT_EXHAUSTED", details: { budget } });
      if (error !== void 0) throw error;
      return value;
    };
    runScenario = async (ast, options = {}) => {
      const seed = options.seed ?? ast.seed ?? 0;
      const harness = options.harness ?? unitSimHarness();
      const kernel = makeKernel(seed, options.controlLog ?? []);
      const capabilityReport = harness.admitScenario(ast, options.capabilities ?? []);
      const compiled = compileScenario(ast, new Set(Object.keys(harness.adapter?.extensionExecutors ?? {})));
      const knownFaults = new Set(ast.faults.map((item) => item.id));
      const invalidControl = (options.controlLog ?? []).find(
        (control) => control.type === "inject-fault" && !knownFaults.has(control.fault) || control.type === "release-barrier" && !ast.barriers.some((item) => item.id === control.barrier) || control.type === "task-restart" && !ast.steps.some((item) => item.id === control.step)
      );
      for (const decision of capabilityReport) kernel.trace.emit({ type: "capability", data: { kind: decision.kind, capability: decision.capability } });
      const base = { replayIdentity: replayIdentity({ ast, seed, controlLog: kernel.controls.log() }), controlLog: kernel.controls.log(), capabilityReport, ambiguity: [], determinismReport: { deterministic: true, residues: [] } };
      const failed = capabilityReport.find((d) => d.kind === "capability-failure");
      const skipped = capabilityReport.find((d) => d.kind === "capability-skip");
      if (failed || skipped) return { ...base, status: failed ? "capability-failure" : "capability-skip", outputs: {}, trace: kernel.trace.snapshot() };
      if (invalidControl) return { ...base, status: "failed", outputs: {}, trace: kernel.trace.snapshot(), error: { name: "ControlError", code: "CONTROL_INVALID", message: `control ${invalidControl.type} is not applicable to this scenario`, details: invalidControl, fidelity: "simulation" } };
      if (!compiled.ok) return { ...base, status: "failed", outputs: {}, trace: kernel.trace.snapshot(), error: { name: "ScenarioCompileError", code: "SCENARIO_INVALID", message: compiled.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "), details: compiled.diagnostics, fidelity: "simulation" } };
      if (harness.kind !== "unit-sim" && !harness.adapter) return { ...base, status: "capability-failure", outputs: {}, trace: kernel.trace.snapshot(), capabilityReport: [...capabilityReport, { kind: "capability-failure", harness: harness.name, capability: harness.kind === "e2e-real-process" ? "real-process" : "real-db", hint: "declaration is not proof: an executable adapter is required" }] };
      if (harness.kind !== "unit-sim" && harness.adapter) {
        const unsupported = ast.faults.filter((candidate) => !harness.adapter?.supportedCutPoints?.has(`${candidate.operation}:${candidate.phase}`));
        if (unsupported.length) {
          const error = { name: "HarnessCapabilityError", code: "ADMISSION_FAILED", message: `real harness cannot execute requested cut point(s): ${unsupported.map((item) => `${item.operation}:${item.phase}`).join(", ")}`, details: { unsupported }, fidelity: "native" };
          const decision = { kind: harness.config.policy === "skip" ? "capability-skip" : "capability-failure", harness: harness.name, capability: "durability-faults", hint: error.message };
          return { ...base, status: decision.kind === "capability-skip" ? "capability-skip" : "capability-failure", outputs: {}, trace: kernel.trace.snapshot(), capabilityReport: [...capabilityReport, decision], error };
        }
      }
      const outputs = {};
      const completed = /* @__PURE__ */ new Set();
      const releasedBarriers = /* @__PURE__ */ new Set();
      const cleanup = new CleanupScope();
      const journal = new JournalModel();
      const ambiguities = [];
      const residues = /* @__PURE__ */ new Set();
      const ids = deterministicIds(seed);
      const recordAmbiguity = (item, id) => {
        ambiguities.push(item);
        kernel.trace.emit({ type: "ambiguity", id, data: { outcome: item.outcome, details: item.details } });
      };
      const program = Effect4.gen(function* () {
        if (harness.adapter) {
          cleanup.register("harness", harness.name, harness.adapter.cleanup ?? (() => void 0));
          try {
            yield* Effect4.tryPromise({ try: () => Promise.resolve(harness.adapter.admissionProbe()), catch: (cause) => Object.assign(new Error(`ADMISSION_FAILED: ${harness.name} did not admit its production system`), { code: "ADMISSION_FAILED", cause, details: { native: harness.adapter?.serializeError?.(cause) } }) });
          } catch (cause) {
            throw cause;
          }
          for (const extension2 of ast.extensions) {
            const executor = harness.adapter.extensionExecutors?.[extension2.name];
            if (!executor) throw Object.assign(new Error(`UNREGISTERED_EXTENSION: ${extension2.name}`), { code: "UNREGISTERED_EXTENSION", details: { extension: extension2.name } });
            yield* Effect4.tryPromise({ try: () => Promise.resolve(executor(extension2.name, extension2.value)), catch: (cause) => cause });
            kernel.trace.emit({ type: "adapter", id: extension2.name, data: { identity: harness.adapter.identity, extension: extension2.name, executed: true } });
          }
        }
        const runtimeKernel = yield* KernelRuntimeService;
        const activeTaskIds = /* @__PURE__ */ new Set();
        let controlIndex = 0;
        const supplied = kernel.controls.log();
        while (controlIndex < supplied.length) {
          const control = supplied[controlIndex];
          if (control.type !== "advance-clock") break;
          controlIndex += 1;
          kernel.controls.takeNext("advance-clock");
          kernel.clock.advance(control.ms);
        }
        while (completed.size < ast.steps.length) {
          for (const barrier2 of ast.barriers) {
            const partiesComplete = barrier2.parties.every((party) => completed.has(party));
            const release = partiesComplete && runtimeKernel.controls.peek()?.type === "release-barrier" ? runtimeKernel.controls.takeNext("release-barrier") : void 0;
            const released = release?.barrier === barrier2.id;
            if (released) releasedBarriers.add(barrier2.id);
            if (partiesComplete && !released && !releasedBarriers.has(barrier2.id)) throw Object.assign(new Error(`barrier ${barrier2.id} timed out waiting for release`), { code: "BARRIER_TIMEOUT", details: { barrier: barrier2.id, budget: barrier2.budget } });
          }
          const ready = ast.steps.filter((s) => !completed.has(s.id) && !activeTaskIds.has(s.id) && s.dependsOn.every((d) => completed.has(d)));
          if (!ready.length && !activeTaskIds.size) throw Object.assign(new Error("no runnable steps remain"), { code: "SCENARIO_DEPENDENCY_UNSATISFIED" });
          if (!ready.length) {
            const winner2 = yield* runtimeKernel.executor.runReadySet([]);
            activeTaskIds.delete(winner2.stepId);
            completed.add(winner2.stepId);
            outputs[winner2.stepId] = winner2.value;
            continue;
          }
          const ordered = [];
          const remaining = [...ready];
          while (remaining.length) {
            const pin = runtimeKernel.controls.takeApplicablePin(remaining.map((s) => s.id));
            const chosen = runtimeKernel.scheduler.choose(remaining, pin ? remaining.findIndex((s) => s.id === pin.choice) : void 0);
            ordered.push(chosen);
            remaining.splice(remaining.indexOf(chosen), 1);
            if (!pin) runtimeKernel.controls.append({ type: "pin-interleaving", choice: chosen.id });
            runtimeKernel.trace.emit({ type: "schedule", id: ids.next(chosen.id), data: { step: chosen.id, ready: ready.map((s) => s.id), choice: chosen.id, controlIndex: runtimeKernel.controls.consumed() } });
          }
          const tasks = ordered.map((selected) => Effect4.gen(function* () {
            const id = ids.next(selected.id);
            let observedWait = false;
            kernel.trace.emit({ type: "task", id, data: { state: "started", step: selected.id } });
            const owner = `sim:${seed}`;
            journal.claimLease(selected.id, owner);
            let controlledFault;
            const runtime = {
              effect: (name, operation) => {
                const effectId = `${selected.id}:${name}`;
                const control = runtimeKernel.controls.takeResolve(effectId) ?? runtimeKernel.controls.takeResolve(name);
                if (control?.outcome === "succeed") {
                  kernel.trace.emit({ type: "effect", id, data: { name, state: "resolved", controlled: true } });
                  return Promise.resolve(control.value);
                }
                if (control?.outcome === "fail") return Promise.reject(Object.assign(new Error(`effect ${name} failed by control`), { code: "CONTROLLED_EFFECT_FAILURE", details: control }));
                if (control?.outcome === "hang") return new Promise(() => void 0);
                const beforeEffect = faultFor(ast.faults, "effect", "before-task");
                if (beforeEffect) return Promise.reject(faultError(beforeEffect));
                const invoke = () => settleKernel(Promise.resolve().then(operation), kernel, options.waitBudget ?? 1e4);
                const run = control?.outcome === "duplicate" ? invoke().then(() => invoke()) : invoke();
                return run.then((value2) => {
                  kernel.trace.emit({ type: "effect", id, data: { name, state: "requested" } });
                  const duringEffect = faultFor(ast.faults, "effect", "during-task");
                  if (duringEffect) throw faultError(duringEffect);
                  journal.assertLease(selected.id, owner);
                  journal.effectApplied(effectId);
                  const effectFault = (controlledFault?.operation === "effect" && controlledFault.phase === "after-effect-before-journal" ? controlledFault : void 0) ?? faultFor(ast.faults, "effect", "after-effect-before-journal");
                  if (effectFault) {
                    recordAmbiguity(ambiguity("effect-applied-journal-missing", { step: selected.id, effect: effectId, transition: "effect-applied->journal-missing", fault: effectFault.id }), id);
                    throw faultError(effectFault);
                  }
                  journal.journal(effectId);
                  const ackFault = (controlledFault?.phase === "after-journal-before-ack" ? controlledFault : void 0) ?? faultFor(ast.faults, "effect", "after-journal-before-ack") ?? faultFor(ast.faults, "attempt-write", "after-journal-before-ack") ?? faultFor(ast.faults, "completion-cas", "after-journal-before-ack");
                  if (ackFault) {
                    recordAmbiguity(ambiguity("journal-applied-ack-missing", { step: selected.id, effect: effectId, transition: "journal-applied->ack-missing", fault: ackFault.id }), id);
                    throw faultError(ackFault);
                  }
                  journal.ack(effectId);
                  const afterAck = (controlledFault?.phase === "after-ack" ? controlledFault : void 0) ?? faultFor(ast.faults, "effect", "after-ack") ?? faultAt(ast.faults, "after-ack");
                  if (afterAck) throw faultError(afterAck);
                  kernel.trace.emit({ type: "effect", id, data: { name, state: "resolved" } });
                  return value2;
                });
              },
              sleep: (ms) => new Promise((resolve3, reject) => {
                observedWait = true;
                const wakeup = `${selected.id}:timer:${ms}`;
                journal.registerWakeup(wakeup);
                const lost = ast.faults.some((candidate) => candidate.operation === "event-append" && (candidate.phase === "during-task" || candidate.phase === "after-task"));
                const timer = kernel.clock.sleep(ms, () => {
                  const suppliedFire = runtimeKernel.controls.take("timer-fire");
                  if (lost) {
                    journal.loseWakeup(wakeup);
                    if (observedWait) recordAmbiguity(ambiguity("lost-wakeup", { step: selected.id, wakeup, transition: "registered->lost" }), id);
                    reject(Object.assign(new Error("lost wakeup"), { code: "LOST_WAKEUP" }));
                    return;
                  }
                  journal.deliverWakeup(wakeup);
                  if (!suppliedFire) runtimeKernel.controls.append({ type: "timer-fire", timer: String(timer) });
                  kernel.trace.emit({ type: "wait", id, data: { state: "timer-fired", ms } });
                  resolve3();
                });
                cleanup.register("virtual-timer", String(timer), () => kernel.clock.cancel(timer));
              }),
              log: (message, data) => kernel.trace.emit({ type: "task", id, data: { state: "log", message, ...data === void 0 ? {} : { data } } }),
              opaque: (name, operation) => {
                kernel.trace.emit({ type: "opaque-effect", id, data: { name, controllable: false } });
                return Promise.resolve().then(operation);
              }
            };
            let productionValue;
            if (harness.adapter?.runStep && harness.kind !== "unit-sim") {
              const productionOperation = harness.kind === "e2e-real-process" ? "runWorkflow" : selected.id;
              productionValue = yield* Effect4.tryPromise({ try: () => Promise.resolve(harness.adapter.runStep(productionOperation, selected.id, selected.input)), catch: (e) => e });
              kernel.trace.emit({ type: "adapter", id, data: { identity: harness.adapter.identity, step: selected.id, executed: true } });
            }
            if (runtimeKernel.controls.peek()?.type === "inject-fault") {
              const control = runtimeKernel.controls.takeNext("inject-fault");
              controlledFault = ast.faults.find((candidate) => candidate.id === control.fault);
              kernel.trace.emit({ type: "fault", id: control.fault, data: control.payload });
            }
            const extensionExecutor = selected.extension ? harness.adapter?.extensionExecutors?.[selected.extension] : void 0;
            if (selected.extension && !extensionExecutor) throw Object.assign(new Error(`UNREGISTERED_STEP_EXTENSION: ${selected.extension}`), { code: "UNREGISTERED_STEP_EXTENSION", details: { step: selected.id, extension: selected.extension } });
            if (selected.extension && extensionExecutor) yield* Effect4.tryPromise({ try: () => Promise.resolve(extensionExecutor(selected.id, selected.input)), catch: (e) => e });
            const duringTransition = void 0;
            const injectable = ast.faults.find((candidate) => candidate.phase === "before-task");
            const injectFault = harness.adapter?.injectFault;
            if (injectable && injectFault && harness.kind !== "unit-sim") yield* Effect4.tryPromise({ try: () => Promise.resolve(injectFault(injectable)), catch: (e) => e });
            const before = (controlledFault?.phase === "before-task" ? controlledFault : void 0) ?? faultFor(ast.faults, "task", "before-task") ?? faultFor(ast.faults, "resume", "before-task") ?? faultAt(ast.faults, "before-task");
            if (before) {
              const item = ambiguityFor(before, selected.id);
              if (item) recordAmbiguity(item, id);
              throw faultError(before);
            }
            if (runtimeKernel.controls.peek()?.type === "cancel") {
              const cancel = runtimeKernel.controls.takeNext("cancel");
              recordAmbiguity(ambiguity("cancellation-race", { step: selected.id, reason: cancel.reason ?? "cancelled", transition: "task-started->cancelled" }), id);
              throw Object.assign(new Error(cancel.reason ?? "scenario cancelled"), { code: "SCENARIO_CANCELLED" });
            }
            if (controlledFault?.phase === "during-task" && !["lease", "heartbeat", "cancellation"].includes(controlledFault.operation)) {
              const item = ambiguityFor(controlledFault, selected.id);
              if (item) recordAmbiguity(item, id);
              throw faultError(controlledFault);
            }
            const runner = options.stepRunners?.[selected.id] ?? stepRunner(selected);
            if (runner) kernel.trace.emit({ type: "opaque-effect", id, data: { name: `step:${selected.id}`, controllable: false } });
            let value;
            const duringFault = ast.faults.find((candidate) => candidate.phase === "during-task");
            if (runner && duringFault) {
              const child = yield* Effect4.fork(Effect4.tryPromise({ try: () => Promise.resolve(runner(runtime, selected.input)), catch: (e) => e }));
              yield* Effect4.yieldNow();
              if (injectFault && harness.kind !== "unit-sim") yield* Effect4.tryPromise({ try: () => Promise.resolve(injectFault(duringFault)), catch: (e) => e });
              yield* Fiber3.interrupt(child);
              if (duringFault.operation === "resume") {
                const item = ambiguityFor(duringFault, selected.id);
                if (item) recordAmbiguity(item, id);
                value = yield* Effect4.tryPromise({ try: () => Promise.resolve(runner(runtime, selected.input)), catch: (e) => e });
              } else {
                if (duringFault.operation === "lease" || duringFault.operation === "heartbeat" || duringFault.operation === "cancellation") journal.loseLease(selected.id);
                const item = ambiguityFor(duringFault, selected.id);
                if (item) recordAmbiguity(item, id);
                throw faultError(duringFault);
              }
            }
            if (runner && !duringFault) value = yield* Effect4.tryPromise({ try: () => Promise.resolve(runner(runtime, selected.input)), catch: (e) => e });
            const duplicateControl = runtimeKernel.controls.find("resolve-effect").find((control) => control.outcome === "duplicate" && (control.effect === selected.id || control.effect.startsWith(`${selected.id}:`)));
            if (duplicateControl && !ambiguities.some((item) => item.details.step === selected.id && item.outcome === "duplicate-delivery")) recordAmbiguity(ambiguity("duplicate-delivery", { step: selected.id, effect: duplicateControl.effect, transition: "effect-resolved->redelivered", journalState: journal.state(duplicateControl.effect) }), id);
            if (runtimeKernel.controls.peek()?.type === "cancel") {
              const cancel = runtimeKernel.controls.takeNext("cancel");
              recordAmbiguity(ambiguity("cancellation-race", { step: selected.id, reason: cancel.reason ?? "cancelled", transition: "task-completed->cancelled" }), id);
              throw Object.assign(new Error(cancel.reason ?? "scenario cancelled"), { code: "SCENARIO_CANCELLED" });
            }
            const pendingControl = runtimeKernel.controls.peek();
            if (pendingControl?.type === "task-restart" && pendingControl.step === selected.id) {
              runtimeKernel.controls.takeNext("task-restart");
              recordAmbiguity(ambiguity("restart-in-task", { step: selected.id, transition: "task-completed->restarted" }), id);
              if (runner) value = yield* Effect4.tryPromise({ try: () => Promise.resolve(runner(runtime, selected.input)), catch: (e) => e });
            }
            const during = controlledFault?.phase === "during-task" ? controlledFault : faultFor(ast.faults, "task", "during-task") ?? faultFor(ast.faults, "lease", "during-task") ?? faultFor(ast.faults, "heartbeat", "during-task") ?? faultFor(ast.faults, "cancellation", "during-task") ?? faultFor(ast.faults, "event-append", "during-task") ?? faultFor(ast.faults, "resume", "during-task") ?? faultAt(ast.faults, "during-task");
            if (during && during.operation !== "resume" && ["lease", "heartbeat", "cancellation"].includes(during.operation) && (runner !== void 0 || observedWait)) {
              if (during.operation === "lease" || during.operation === "heartbeat") journal.loseLease(selected.id);
              try {
                journal.assertLease(selected.id, owner);
              } catch (cause) {
                const outcome = during.operation === "cancellation" ? "cancellation-race" : "lease-lost";
                recordAmbiguity(ambiguity(outcome, { step: selected.id, transition: "owned->fenced", cause: String(cause.message) }), id);
                throw faultError(during);
              }
            } else if (during && during.operation !== "resume") {
              const item = ambiguityFor(during, selected.id, void 0, observedWait);
              if (item && !["lease", "heartbeat", "cancellation"].includes(during.operation)) recordAmbiguity(item, id);
              throw faultError(during);
            }
            const after = (controlledFault?.phase === "after-task" ? controlledFault : void 0) ?? faultFor(ast.faults, "task", "after-task") ?? faultFor(ast.faults, "completion-cas", "after-task") ?? faultFor(ast.faults, "event-append", "after-task") ?? faultFor(ast.faults, "resume", "after-task") ?? faultAt(ast.faults, "after-task");
            if (after) {
              if (injectFault && harness.kind !== "unit-sim" && after.operation !== "task") yield* Effect4.tryPromise({ try: () => Promise.resolve(injectFault(after)), catch: (e) => e });
              const item = ambiguityFor(after, selected.id, void 0, after.operation !== "event-append" && after.operation !== "completion-cas" || observedWait);
              if (item) recordAmbiguity(item, id);
              throw faultError(after);
            }
            kernel.trace.emit({ type: "task", id, data: { state: "finished", step: selected.id } });
            return harness.kind === "unit-sim" ? value : productionValue;
          }));
          for (const selected of ordered) activeTaskIds.add(selected.id);
          const winner = yield* runtimeKernel.executor.runReadySet(tasks.map((effect, index) => ({ stepId: ordered[index].id, effect })));
          activeTaskIds.delete(winner.stepId);
          outputs[winner.stepId] = winner.value;
          completed.add(winner.stepId);
        }
        for (const item of ast.barriers) {
          const pendingRelease = kernel.controls.peek();
          const release = pendingRelease?.type === "release-barrier" && pendingRelease.barrier === item.id ? kernel.controls.takeNext("release-barrier") : void 0;
          const released = release?.barrier === item.id || releasedBarriers.has(item.id);
          if (!released) throw Object.assign(new Error(`barrier ${item.id} timed out waiting for release`), { code: "BARRIER_TIMEOUT", details: { barrier: item.id, budget: item.budget } });
          kernel.trace.emit({ type: "barrier", id: item.id, data: { state: "released", parties: item.parties } });
        }
        const leftover = runtimeKernel.controls.pendingControls();
        if (leftover.length) throw Object.assign(new Error(`CONTROL_UNCONSUMED: ${leftover.map((control) => control.type).join(", ")}`), { code: "CONTROL_UNCONSUMED", details: { controls: leftover } });
        return outputs;
      });
      const execution = runAtBoundaryFork(program.pipe(Effect4.provide(kernelLayer(kernel))));
      let result;
      try {
        if (harness.kind === "unit-sim") result = await settleKernel(execution.promise, kernel, options.waitBudget ?? 1e4);
        else result = await Promise.race([execution.promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("BOUNDED_WAIT_EXHAUSTED: real harness did not settle"), { code: "BOUNDED_WAIT_EXHAUSTED" })), Math.max(1, options.waitBudget ?? 1e4)))]);
      } catch (cause) {
        await execution.interrupt();
        result = { ok: false, error: { name: "BoundedWaitError", code: cause.code ?? "BOUNDED_WAIT_EXHAUSTED", message: String(cause) } };
      }
      let cleanupFailure;
      try {
        await cleanup.close(options.cleanupBudget ?? 100);
      } catch (cause) {
        cleanupFailure = cause;
      }
      try {
        assertNoLeaks(cleanup, kernel.clock.pending().map((timer) => ({ kind: "virtual-timer", id: String(timer.id) })));
      } catch (cause) {
        cleanupFailure ??= cause;
      }
      if (cleanupFailure) {
        const primary = result.ok ? void 0 : result.error;
        const cleanupCode = cleanupFailure.code === "CLEANUP_LEAK" ? "CLEANUP_LEAK" : "CLEANUP_FAILED";
        result = { ok: false, error: { name: cleanupCode === "CLEANUP_LEAK" ? "CleanupLeakError" : "CleanupError", code: cleanupCode, message: String(cleanupFailure.message), details: { cleanup: cleanupFailure, ...primary ? { primary } : {} }, ...primary ? { cause: primary } : {} } };
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
  }
});

// src/fakeAgent.ts
import { closeSync, constants as fsConstants, writeFileSync } from "fs";
import { lstat, mkdir, open, realpath } from "fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "path";
import { zodSchemaToJsonExample } from "@smithers-orchestrator/components/zod-to-example";
var autoMarker = /* @__PURE__ */ Symbol.for("smithers.testing.auto");
var auto = Object.freeze({
  [autoMarker]: true
});
function isAuto(value) {
  return Boolean(value && typeof value === "object" && value[autoMarker] === true);
}
function schemaExample(schema) {
  const raw = zodSchemaToJsonExample(schema);
  const parsed = JSON.parse(raw);
  return assertSchema(schema, parsed);
}
function formatIssues(issues) {
  if (issues.length === 0) return "unknown validation failure";
  return issues.map((issue) => {
    if (issue && typeof issue === "object" && "message" in issue) {
      return String(issue.message);
    }
    return JSON.stringify(issue);
  }).join("; ");
}
function assertSchema(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new TypeError(`Fake agent output failed validation: ${formatIssues(result.error.issues)}`);
}
function hasResponseKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "output" in value || "text" in value || "files" in value;
}
function normalizeResult(schema, result) {
  if (isAuto(result)) {
    return { output: schemaExample(schema) };
  }
  if (hasResponseKeys(result) && "output" in result) {
    const parsedOutput = schema.safeParse(result.output);
    if (parsedOutput.success) {
      const response = { output: parsedOutput.data };
      if (typeof result.text === "string") response.text = result.text;
      if (result.files) response.files = result.files;
      return response;
    }
  }
  const asOutput = schema.safeParse(result);
  if (asOutput.success) {
    return { output: asOutput.data };
  }
  if (hasResponseKeys(result)) {
    const response = {};
    if ("output" in result) response.output = assertSchema(schema, result.output);
    if (typeof result.text === "string") response.text = result.text;
    if (result.files) response.files = result.files;
    return response;
  }
  return { output: assertSchema(schema, result) };
}
function assertSafeRelativePath(path) {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
    throw new TypeError(`Fake agent file path must stay inside rootDir: ${path}`);
  }
}
function unsafeFilePath(path) {
  return new TypeError(`Fake agent file path must stay inside rootDir: ${path}`);
}
function isErrnoException(error) {
  return error instanceof Error && ("code" in error || "errno" in error);
}
async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return void 0;
    throw error;
  }
}
async function ensureSafeParentDirectories(root, target, name) {
  const parent = dirname(target);
  const parentRelative = relative(root, parent);
  if (!parentRelative) return;
  let current = root;
  for (const component of parentRelative.split(sep)) {
    current = join(current, component);
    let stats = await lstatIfExists(current);
    if (!stats) {
      try {
        await mkdir(current);
      } catch (error) {
        if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      }
      stats = await lstat(current);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw unsafeFilePath(name);
    }
  }
}
async function writeFileWithoutFollowingSymlinks(root, target, name, contents) {
  await ensureSafeParentDirectories(root, target, name);
  await ensureSafeParentDirectories(root, target, name);
  const existingTarget = await lstatIfExists(target);
  if (existingTarget?.isSymbolicLink()) {
    throw unsafeFilePath(name);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow, 438);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ELOOP") {
      throw unsafeFilePath(name);
    }
    throw error;
  }
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}
var posixFsPromise;
async function loadPosixFs() {
  if (posixFsPromise) return posixFsPromise;
  posixFsPromise = import("koffi").then((module) => {
    const koffi = "default" in module ? module.default : module;
    const libc = koffi.load(null);
    return {
      openat: libc.func("int openat(int dirfd, const char *path, int flags, ...)"),
      mkdirat: libc.func("int mkdirat(int dirfd, const char *path, int mode)"),
      errno: koffi.errno,
      errors: koffi.os.errno
    };
  });
  return posixFsPromise;
}
function posixError(operation, path, errno) {
  const error = new Error(`${operation} failed for ${path} (errno ${errno})`);
  error.errno = errno;
  return error;
}
function isUnsafePosixError(posix, errno) {
  return errno === posix.errors.ELOOP || errno === posix.errors.ENOTDIR;
}
function openAt(posix, directory, path, flags, mode) {
  const fd = mode === void 0 ? posix.openat(directory, path, flags) : posix.openat(directory, path, flags, "int", mode);
  if (fd >= 0) return fd;
  throw posixError("openat", path, posix.errno());
}
function directoryOpenFlags() {
  return fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | closeOnExecFlag();
}
function closeOnExecFlag() {
  const constants = fsConstants;
  return constants.O_CLOEXEC ?? 0;
}
function openExistingDirectoryAt(posix, directory, component, name) {
  try {
    return openAt(posix, directory, component, directoryOpenFlags());
  } catch (error) {
    if (isErrnoException(error) && typeof error.errno === "number" && isUnsafePosixError(posix, error.errno)) {
      throw unsafeFilePath(name);
    }
    throw error;
  }
}
function openOrCreateDirectoryAt(posix, directory, component, name) {
  try {
    return openExistingDirectoryAt(posix, directory, component, name);
  } catch (error) {
    if (!isErrnoException(error) || error.errno !== posix.errors.ENOENT) throw error;
  }
  if (posix.mkdirat(directory, component, 511) < 0) {
    const errno = posix.errno();
    if (errno !== posix.errors.EEXIST) throw posixError("mkdirat", component, errno);
  }
  return openExistingDirectoryAt(posix, directory, component, name);
}
function openCanonicalDirectory(posix, path, name) {
  const { root } = parse(path);
  let current = openAt(posix, 0, root, directoryOpenFlags());
  try {
    const remainder = relative(root, path);
    if (!remainder) return current;
    for (const component of remainder.split(sep)) {
      const next = openExistingDirectoryAt(posix, current, component, name);
      closeSync(current);
      current = next;
    }
    return current;
  } catch (error) {
    closeSync(current);
    throw error;
  }
}
async function openRootDirectory(posix, lexicalRoot) {
  const missing = [];
  let existing = lexicalRoot;
  let canonical;
  while (true) {
    try {
      canonical = await realpath(existing);
      break;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  let current = openCanonicalDirectory(posix, canonical, lexicalRoot);
  try {
    for (const component of missing) {
      const next = openOrCreateDirectoryAt(posix, current, component, lexicalRoot);
      closeSync(current);
      current = next;
    }
    return current;
  } catch (error) {
    closeSync(current);
    throw error;
  }
}
function writeFileAt(posix, root, path, name, contents) {
  const components = path.split(sep);
  const filename = components.pop();
  if (!filename) throw unsafeFilePath(name);
  let current = root;
  let ownsCurrent = false;
  try {
    for (const component of components) {
      const next = openOrCreateDirectoryAt(posix, current, component, name);
      if (ownsCurrent) closeSync(current);
      current = next;
      ownsCurrent = true;
    }
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW | closeOnExecFlag();
    let file;
    try {
      file = openAt(posix, current, filename, flags, 438);
    } catch (error) {
      if (isErrnoException(error) && typeof error.errno === "number" && isUnsafePosixError(posix, error.errno)) {
        throw unsafeFilePath(name);
      }
      throw error;
    }
    try {
      writeFileSync(file, contents);
    } finally {
      closeSync(file);
    }
  } finally {
    if (ownsCurrent) closeSync(current);
  }
}
async function writeFiles(rootDir, files) {
  if (!files || Object.keys(files).length === 0) return;
  if (!rootDir) {
    throw new TypeError("Fake agent files require a rootDir");
  }
  const lexicalRoot = resolve(rootDir);
  if (process.platform === "win32") {
    await mkdir(lexicalRoot, { recursive: true });
    const root2 = await realpath(lexicalRoot);
    for (const [name, contents] of Object.entries(files)) {
      assertSafeRelativePath(name);
      const target = resolve(root2, name);
      const rel = relative(root2, target);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new TypeError(`Fake agent file path must stay inside rootDir: ${name}`);
      }
      await writeFileWithoutFollowingSymlinks(root2, target, name, contents);
    }
    return;
  }
  const posix = await loadPosixFs();
  const root = await openRootDirectory(posix, lexicalRoot);
  try {
    for (const [name, contents] of Object.entries(files)) {
      assertSafeRelativePath(name);
      const target = resolve(lexicalRoot, name);
      const rel = relative(lexicalRoot, target);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new TypeError(`Fake agent file path must stay inside rootDir: ${name}`);
      }
      writeFileAt(posix, root, rel, name, contents);
    }
  } finally {
    closeSync(root);
  }
}
function buildFakeAgent(schema, script, options = {}) {
  const calls = [];
  const agent = {
    id: options.id ?? "fake-agent",
    model: options.model ?? "fake-agent",
    tools: {},
    supportsNativeStructuredOutput: options.supportsNativeStructuredOutput ?? true,
    calls,
    async generate(args = {}) {
      const call = {
        args,
        prompt: args.prompt,
        rootDir: typeof args.rootDir === "string" ? args.rootDir : void 0,
        taskContext: args.taskContext
      };
      calls.push(call);
      const raw = typeof script === "function" ? await script(args) : script;
      const response = normalizeResult(schema, raw);
      await writeFiles(call.rootDir, response.files);
      const generated = {};
      if ("output" in response) generated.output = response.output;
      if (response.text !== void 0) generated.text = response.text;
      return generated;
    },
    lastPrompt() {
      return calls.at(-1)?.prompt;
    },
    reset() {
      calls.length = 0;
    }
  };
  return agent;
}
function buildSequenceAgent(schema, entries, options = {}) {
  let index = 0;
  return buildFakeAgent(
    schema,
    () => {
      if (index >= entries.length) {
        throw new Error(`Fake agent sequence exhausted after ${entries.length} call(s)`);
      }
      return entries[index++];
    },
    options
  );
}
var fakeAgent = Object.assign(buildFakeAgent, {
  sequence: buildSequenceAgent
});

// src/renderWorkflow.ts
import { SmithersCtx } from "@smithers-orchestrator/driver/SmithersCtx";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler";
import { canonicalizeXml } from "@smithers-orchestrator/graph/utils/xml";
function buildRuntimeConfig(options) {
  return {
    ...options.runtimeConfig,
    ...options.baseRootDir !== void 0 ? { baseRootDir: options.baseRootDir } : {},
    ...options.workflowPath !== void 0 ? { workflowPath: options.workflowPath } : {}
  };
}
function buildExtractOptions(options) {
  return {
    defaultIteration: options.iteration ?? 0,
    ralphIterations: options.iterations,
    baseRootDir: options.baseRootDir ?? options.runtimeConfig?.baseRootDir,
    workflowPath: options.workflowPath ?? options.runtimeConfig?.workflowPath ?? null
  };
}
async function renderWorkflow(workflow, options = {}) {
  const ctx = new SmithersCtx({
    runId: options.runId ?? "test-run",
    iteration: options.iteration ?? 0,
    iterations: options.iterations,
    input: options.input ?? {},
    auth: options.auth ?? null,
    outputs: options.outputs ?? {},
    zodToKeyName: workflow.zodToKeyName,
    runtimeConfig: buildRuntimeConfig(options)
  });
  const renderer = options.renderer ?? new SmithersRenderer();
  const graph = await renderer.render(
    workflow.build(ctx),
    buildExtractOptions(options)
  );
  const baseRootDir = options.baseRootDir ?? options.runtimeConfig?.baseRootDir;
  const workflowPath = options.workflowPath ?? options.runtimeConfig?.workflowPath ?? null;
  const engineHelpers = await import("@smithers-orchestrator/engine/engine");
  const computeHelpers = await import("@smithers-orchestrator/engine/task-compute-fns");
  engineHelpers.resolveTaskOutputs(graph.tasks, workflow);
  computeHelpers.attachSubflowComputeFns(graph.tasks, workflow, {
    rootDir: baseRootDir,
    workflowPath
  });
  computeHelpers.attachSandboxComputeFns(graph.tasks, workflow, {
    rootDir: baseRootDir,
    workflowPath
  });
  return {
    ...graph,
    runId: ctx.runId,
    frameNo: options.frameNo ?? 0,
    graph,
    ctx,
    toXml() {
      return canonicalizeXml(graph.xml);
    }
  };
}

// src/renderPrompt.ts
import { renderPromptToText } from "@smithers-orchestrator/components/components/Task";

// src/runTask.ts
async function runTask(task, options = {}) {
  if (task.kind === "static" || task.staticPayload !== void 0) {
    return validateOutput(task, task.staticPayload);
  }
  if (task.kind === "compute" || task.computeFn) {
    if (!task.computeFn) {
      throw new TypeError(`Task ${task.nodeId} is marked compute but has no compute function`);
    }
    return validateOutput(task, await task.computeFn());
  }
  const agent = Array.isArray(task.agent) ? task.agent[Math.min((options.attempt ?? 1) - 1, task.agent.length - 1)] : task.agent;
  if (!agent?.generate) {
    throw new TypeError(`Task ${task.nodeId} has no runnable agent, compute function, or static payload`);
  }
  const result = await agent.generate({
    prompt: task.prompt,
    outputSchema: task.outputSchema,
    rootDir: options.rootDir,
    taskContext: {
      runId: options.runId,
      nodeId: task.nodeId,
      iteration: task.iteration,
      attempt: options.attempt ?? 1
    }
  });
  if (result && typeof result === "object" && "output" in result) {
    return validateOutput(task, result.output);
  }
  if (task.outputSchema) return validateOutput(task, result);
  return result;
}
function validateOutput(task, value) {
  if (!task.outputSchema) return value;
  const parsed = task.outputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const message = parsed.error.issues.map((issue) => issue.message).join("; ");
  throw new TypeError(`Task ${task.nodeId} output failed validation: ${message}`);
}

// src/simulate.ts
import { zodSchemaToJsonExample as zodSchemaToJsonExample2 } from "@smithers-orchestrator/components/zod-to-example";
import { WorkflowDriver } from "@smithers-orchestrator/driver";
import { SmithersRenderer as SmithersRenderer2 } from "@smithers-orchestrator/react-reconciler";
import { makeWorkflowSession } from "@smithers-orchestrator/scheduler";
import { Effect } from "effect";
function createRunId() {
  return `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isFakeAgent(value) {
  return isObject(value) && typeof value.generate === "function";
}
function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
function globMatches(pattern, value) {
  const source = `^${escapeRegExp(pattern).replace(/\*/g, ".*")}$`;
  return new RegExp(source).test(value);
}
function formatAgentTaskIds(agentTaskIds) {
  return JSON.stringify([...new Set(agentTaskIds)].sort());
}
function formatIssues2(issues) {
  if (issues.length === 0) return "unknown validation failure";
  return issues.map((issue) => {
    if (!isObject(issue)) return JSON.stringify(issue);
    const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
    const message = "message" in issue ? String(issue.message) : JSON.stringify(issue);
    return `${path}${message}`;
  }).join("; ");
}
function simulatorError(message, code = "SIMULATION_ERROR") {
  const error = new Error(message);
  error.name = "SimulationError";
  error.code = code;
  error.details = { failureRetryable: false };
  return error;
}
function schemaExample2(task) {
  if (!task.outputSchema) {
    throw simulatorError(
      `simulate(): auto mock for task "${task.nodeId}" requires an outputSchema.`,
      "AGENT_CONFIG_INVALID"
    );
  }
  return JSON.parse(zodSchemaToJsonExample2(task.outputSchema));
}
function validateTaskOutput(task, value) {
  if (!task.outputSchema) return value;
  const parsed = task.outputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw simulatorError(
    `simulate(): task "${task.nodeId}" output failed validation: ${formatIssues2(parsed.error.issues)}`,
    "INVALID_OUTPUT"
  );
}
function isAgentTask(task) {
  return task.kind === "agent" || task.agent != null && task.computeFn == null && task.staticPayload === void 0;
}
function getTaskRecord(records, nodeId) {
  let record = records.get(nodeId);
  if (!record) {
    record = { status: "pending", outputs: [], prompts: [] };
    records.set(nodeId, record);
  }
  return record;
}
function copyTaskRecord(record) {
  return {
    status: record?.status ?? "pending",
    outputs: [...record?.outputs ?? []],
    prompts: [...record?.prompts ?? []]
  };
}
function resolveMock(mocks, task, agentTask) {
  if (Object.prototype.hasOwnProperty.call(mocks, task.nodeId)) {
    return { matched: true, key: task.nodeId, value: mocks[task.nodeId] };
  }
  for (const key of Object.keys(mocks)) {
    if (key === "*" || !key.includes("*")) continue;
    if (globMatches(key, task.nodeId)) {
      return { matched: true, key, value: mocks[key] };
    }
  }
  if (agentTask && Object.prototype.hasOwnProperty.call(mocks, "*")) {
    return { matched: true, key: "*", value: mocks["*"] };
  }
  return { matched: false };
}
function updateUnusedMocks(handle, mocks, consumedMocks) {
  handle.unusedMocks = Object.keys(mocks).filter((key) => !consumedMocks.has(key));
}
async function materializeMock(mock, task, context, rootDir, runId) {
  if (isAuto(mock)) {
    return schemaExample2(task);
  }
  if (isFakeAgent(mock)) {
    const result = await mock.generate({
      prompt: task.prompt,
      outputSchema: task.outputSchema,
      rootDir: context.options.rootDir ?? rootDir,
      taskContext: {
        runId,
        nodeId: task.nodeId,
        iteration: task.iteration,
        attempt: 1
      }
    });
    return result.output;
  }
  if (typeof mock === "function") {
    const result = await mock({
      nodeId: task.nodeId,
      iteration: task.iteration,
      attempt: 1,
      prompt: task.prompt,
      rootDir: context.options.rootDir ?? rootDir,
      outputSchema: task.outputSchema
    });
    if (isObject(result) && "output" in result) {
      return result.output;
    }
    return result;
  }
  return mock;
}
function simulate(workflow, options = {}) {
  const runId = createRunId();
  const mocks = options.mocks ?? {};
  const consumedMocks = /* @__PURE__ */ new Set();
  const taskRecords = /* @__PURE__ */ new Map();
  const latestTasks = /* @__PURE__ */ new Map();
  let latestAgentTaskIds = [];
  let runPromise;
  let lastExecutionError;
  const handle = {
    status: "pending",
    output: void 0,
    outputs: {},
    executed: [],
    unusedMocks: Object.keys(mocks),
    warnings: [],
    run() {
      runPromise ??= runSimulation();
      return runPromise;
    },
    task(id) {
      if (!taskRecords.has(id) && latestTasks.has(id)) {
        taskRecords.set(id, { status: "pending", outputs: [], prompts: [] });
      }
      return copyTaskRecord(taskRecords.get(id));
    }
  };
  const smithersRenderer = new SmithersRenderer2();
  const renderer = {
    async render(element, extractOptions) {
      const graph = await smithersRenderer.render(element, extractOptions);
      const rootDir = extractOptions?.baseRootDir ?? options.rootDir;
      const workflowPath = extractOptions?.workflowPath ?? options.workflowPath ?? null;
      const engineHelpers = await import("@smithers-orchestrator/engine/engine");
      const computeHelpers = await import("@smithers-orchestrator/engine/task-compute-fns");
      engineHelpers.resolveTaskOutputs(graph.tasks, workflow);
      computeHelpers.attachSubflowComputeFns(graph.tasks, workflow, {
        rootDir,
        workflowPath
      });
      computeHelpers.attachSandboxComputeFns(graph.tasks, workflow, {
        rootDir,
        workflowPath
      });
      latestTasks.clear();
      for (const task of graph.tasks) {
        latestTasks.set(task.nodeId, task);
      }
      latestAgentTaskIds = graph.tasks.filter(isAgentTask).map((task) => task.nodeId);
      return graph;
    }
  };
  const executeTask = async (task, context) => {
    const record = getTaskRecord(taskRecords, task.nodeId);
    handle.executed.push(task.nodeId);
    record.prompts.push(task.prompt);
    const agentTask = isAgentTask(task);
    try {
      const mock = resolveMock(mocks, task, agentTask);
      let value;
      if (mock.matched) {
        consumedMocks.add(mock.key);
        updateUnusedMocks(handle, mocks, consumedMocks);
        value = await materializeMock(mock.value, task, context, options.rootDir, runId);
      } else if (agentTask) {
        throw simulatorError(
          `simulate(): agent task "${task.nodeId}" has no mock. Provide mocks[${JSON.stringify(task.nodeId)}], a glob, "*": auto, or a per-node value. Agent tasks in this run: ${formatAgentTaskIds(latestAgentTaskIds)}`,
          "AGENT_CONFIG_INVALID"
        );
      } else if (task.computeFn) {
        value = await task.computeFn();
      } else {
        value = task.staticPayload ?? null;
      }
      const parsed = validateTaskOutput(task, value);
      const channel = task.outputTableName;
      (handle.outputs[channel] ??= []).push(parsed);
      record.outputs.push(parsed);
      record.status = "finished";
      handle.output = parsed;
      return parsed;
    } catch (error) {
      record.status = "failed";
      lastExecutionError = error;
      throw error;
    }
  };
  async function runSimulation() {
    handle.status = "running";
    try {
      const driver = new WorkflowDriver({
        workflow,
        runtime: {
          runPromise: (effect) => Effect.runPromise(effect)
        },
        renderer,
        createSession: (sessionOptions) => makeWorkflowSession({ runId: sessionOptions.runId }),
        executeTask
      });
      const result = await driver.run({
        runId,
        input: options.input ?? {},
        initialOutputs: {},
        rootDir: options.rootDir,
        workflowPath: options.workflowPath ?? void 0
      });
      handle.status = result.status;
      if (result.output !== void 0) {
        handle.output = result.output;
      }
      if (result.failedChildren && result.failedChildren > 0) {
        handle.warnings.push(
          `simulate(): run finished with ${result.failedChildren} failed child task(s).`
        );
      }
      if (result.status === "failed") {
        handle.error = lastExecutionError ?? result.error;
        throw handle.error instanceof Error ? handle.error : simulatorError(String(handle.error ?? "simulate(): run failed"));
      }
      return handle;
    } catch (error) {
      handle.status = "failed";
      handle.error = error;
      throw error;
    } finally {
      updateUnusedMocks(handle, mocks, consumedMocks);
    }
  }
  return handle;
}

// src/matchers.ts
function executedOf(received) {
  return Array.isArray(received.executed) ? received.executed : [];
}
function formatValue(value) {
  return JSON.stringify(value);
}
function hasSubsequence(actual, expected) {
  let expectedIndex = 0;
  for (const id of actual) {
    if (id === expected[expectedIndex]) {
      expectedIndex += 1;
    }
    if (expectedIndex === expected.length) {
      return true;
    }
  }
  return expectedIndex === expected.length;
}
function toHaveExecuted(received, ids) {
  const executed = executedOf(received);
  const missing = ids.filter((id) => !executed.includes(id));
  const pass = missing.length === 0;
  return {
    pass,
    message: () => pass ? `Expected simulation not to have executed ${formatValue(ids)}, but actual executed nodes were ${formatValue(executed)}.` : `Expected simulation to have executed ${formatValue(ids)}, but missing ids were ${formatValue(missing)}. Actual executed nodes were ${formatValue(executed)}.`
  };
}
function toHaveExecutedInOrder(received, ids) {
  const executed = executedOf(received);
  const pass = hasSubsequence(executed, ids);
  return {
    pass,
    message: () => pass ? `Expected simulation not to have executed in order ${formatValue(ids)}, but actual executed order was ${formatValue(executed)}.` : `Expected simulation to have executed in order ${formatValue(ids)}, but actual executed order was ${formatValue(executed)}.`
  };
}
function toHaveFinished(received) {
  const pass = received.status === "finished";
  return {
    pass,
    message: () => pass ? 'Expected simulation not to have finished, but status was "finished".' : `Expected simulation to have finished, but status was ${formatValue(received.status)}.`
  };
}
var simMatchers = { toHaveExecuted, toHaveExecutedInOrder, toHaveFinished };

// src/index.ts
init_builder();
init_compile();
init_canonicalize();
init_replayIdentity();
init_VirtualClock();
init_SeededScheduler();
init_ControlBus();
init_TraceCollector();

// src/kernel/BoundedWait.ts
var BoundedWaitError = class extends Error {
  constructor(budget) {
    super("bounded wait budget exhausted");
    this.budget = budget;
    this.name = "BoundedWaitError";
  }
  budget;
  code = "WAIT_BUDGET_EXHAUSTED";
};
var boundedWait = async (budget, operation) => {
  if (!Number.isInteger(budget.steps) || budget.steps < 1 || budget.ms !== void 0 && (!Number.isFinite(budget.ms) || budget.ms < 0)) throw new BoundedWaitError(budget);
  let steps = budget.steps;
  while (steps-- > 0) {
    const attempt = Promise.resolve().then(() => operation({ steps }));
    if (budget.ms === void 0) return await attempt;
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new BoundedWaitError(budget)), budget.ms);
    });
    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      if (timeout !== void 0) clearTimeout(timeout);
    }
  }
  throw new BoundedWaitError(budget);
};

// src/index.ts
init_Harness();

// src/harness/e2eDescriptor.ts
init_Harness();
var e2eDescriptor = (config = {}) => makeHarness("e2e-real-process", config);

// src/index.ts
init_capabilities();

// src/harness/errors.ts
var SimulationError = class extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "SimulationError";
  }
  code;
  details;
  fidelity = "simulation";
};

// src/index.ts
init_runScenario();

// src/dryRun.ts
init_canonicalize();
init_replayIdentity();
init_runScenario();
init_compile();

// src/replay/ReplayBundle.ts
init_canonicalize();
init_replayIdentity();
init_builder();
var makeReplayBundle = (input) => Object.freeze({ version: 1, ast: JSON.parse(canonicalize(input.ast)), seed: input.seed, controlLog: JSON.parse(JSON.stringify(input.controlLog)), trace: JSON.parse(JSON.stringify(input.trace ?? [])), ambiguity: JSON.parse(JSON.stringify(input.ambiguity ?? [])), determinism: input.determinism ?? { deterministic: true, residues: [] }, harness: input.harness ?? "unit-sim", runnerBindings: Object.fromEntries(input.ast.steps.filter((step2) => step2.runnerBinding).map((step2) => [step2.id, step2.runnerBinding])), replayIdentity: replayIdentity(input) });
var serializeReplayBundle = (bundle) => JSON.stringify(bundle);
var loadReplayBundle = (serialized) => {
  const value = JSON.parse(serialized);
  if (value.version !== 1 || !value.ast || !Array.isArray(value.controlLog) || typeof value.seed !== "number") throw new Error("INVALID_REPLAY_BUNDLE");
  const bundle = makeReplayBundle(value);
  if (bundle.replayIdentity !== value.replayIdentity) throw new Error("REPLAY_IDENTITY_MISMATCH");
  return Object.freeze({ ...bundle, runnerBindings: value.runnerBindings ?? {} });
};
var replayBundle = async (bundle, options = {}) => {
  const { runScenario: runScenario2 } = await Promise.resolve().then(() => (init_runScenario(), runScenario_exports));
  const selectedHarness = options.harness?.name ?? "unit-sim";
  if (selectedHarness !== bundle.harness) throw new Error(`REPLAY_HARNESS_MISMATCH: bundle=${bundle.harness} selected=${selectedHarness}`);
  const runners2 = options.stepRunners ?? {};
  const missing = bundle.ast.steps.filter((step2) => step2.runnerBinding && !runners2[step2.id] && !stepRunner(step2)).map((step2) => step2.id);
  if (missing.length) throw new Error(`REPLAY_RUNNER_MISSING: ${missing.join(", ")}`);
  return runScenario2(bundle.ast, { ...options, ...Object.keys(runners2).length ? { stepRunners: runners2 } : {}, seed: bundle.seed, controlLog: bundle.controlLog });
};

// src/dryRun.ts
var dryRun = (ast, options = {}) => {
  const seed = options.seed ?? ast.seed ?? 0;
  const controls = options.controlLog ?? [];
  const harness = options.harness;
  const compiled = compileScenario(ast, new Set(Object.keys(harness?.adapter?.extensionExecutors ?? {})));
  return { canonicalAst: canonicalize(ast), replayIdentity: replayIdentity({ ast, seed, controlLog: controls }), admissions: harness?.admitScenario(ast, options.capabilities ?? []) ?? [], diagnostics: compiled.ok ? [] : compiled.diagnostics, requiredCapabilities: compiled.requiredCapabilities, replayBundle: makeReplayBundle({ ast, seed, controlLog: controls, harness: harness?.name }), plannedSteps: ast.steps.map((step2) => step2.id), executesAgents: false, run: () => runScenario(ast, options) };
};

// src/index.ts
init_ambiguity();
init_journalModel();

// src/durability/cutPoints.ts
var cutPoint = (phase, operation) => Object.freeze({ phase, operation });

// src/effects/mediatedEffects.ts
var EffectLedger = class {
  requests = [];
  outcomes = /* @__PURE__ */ new Map();
  journal = /* @__PURE__ */ new Map();
  request(request) {
    this.requests.push(Object.freeze({ ...request }));
  }
  resolve(id, outcome) {
    this.outcomes.set(id, Object.freeze({ ...outcome }));
  }
  get(id) {
    return this.outcomes.get(id);
  }
  recordJournal(id) {
    this.journal.set(id, (this.journal.get(id) ?? 0) + 1);
  }
  journalCount(id) {
    return this.journal.get(id) ?? 0;
  }
  snapshot() {
    return { requests: [...this.requests], outcomes: Object.fromEntries(this.outcomes), journal: Object.fromEntries(this.journal) };
  }
};
var mediatedEffect = async (ledger, request, execute) => {
  ledger.request(request);
  const outcome = ledger.get(request.id);
  if (outcome?.kind === "fail") throw outcome.value;
  if (outcome?.kind === "hang") throw Object.assign(new Error("effect resolution was not supplied within the run budget"), { code: "EFFECT_WAIT_BUDGET_EXHAUSTED" });
  if (outcome?.kind === "succeed") {
    ledger.recordJournal(request.id);
    return outcome.value;
  }
  if (outcome?.kind === "duplicate") {
    const first = await execute();
    ledger.recordJournal(request.id);
    await execute();
    return first;
  }
  const value = await execute();
  ledger.recordJournal(request.id);
  return value;
};

// src/effects/opaque.ts
var opaqueEffect = (description = "unmediated external effect") => Object.freeze({ kind: "opaque-effect", description });
var isOpaqueEffect = (value) => !!value && typeof value === "object" && value.kind === "opaque-effect";

// src/probes/compareBoundaryShape.ts
var publicErrorFields = (value) => Object.fromEntries(["name", "message", "code", "tag", "summary", "details", "docsUrl", "cause"].filter((key) => value[key] !== void 0).map((key) => [key, value[key]]));
var ownErrorField = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.get ? descriptor.get.call(value) : descriptor?.value;
};
var boundarySerializable = (value, seen = /* @__PURE__ */ new Set()) => {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const record = value;
  return publicErrorFields({ name: ownErrorField(record, "name"), message: ownErrorField(record, "message"), code: ownErrorField(record, "code"), tag: ownErrorField(record, "tag"), summary: ownErrorField(record, "summary"), details: ownErrorField(record, "details"), docsUrl: ownErrorField(record, "docsUrl"), cause: ownErrorField(record, "cause") === void 0 ? void 0 : boundarySerializable(ownErrorField(record, "cause"), seen) });
};
var boundaryShape = (error, serialized) => {
  const value = error && typeof error === "object" ? error : {};
  const name = ownErrorField(value, "name") ?? value.name;
  const message = ownErrorField(value, "message") ?? value.message;
  const causeValue = ownErrorField(value, "cause") ?? value.cause;
  const details = ownErrorField(value, "details") ?? value.details;
  const cause = causeValue === void 0 ? void 0 : boundaryShape(causeValue);
  const nativeSerialized = serialized ?? (error instanceof Error ? boundarySerializable(error) : void 0);
  return { name: String(name ?? "Error"), className: error && typeof error === "object" ? String(error.constructor?.name ?? "Object") : "Error", ...value.tag === void 0 ? {} : { tag: String(value.tag) }, ...value.code === void 0 ? {} : { code: String(value.code) }, ...message === void 0 ? {} : { message: String(message) }, ...value.summary === void 0 ? {} : { summary: String(value.summary) }, hasCause: causeValue !== void 0, ...cause ? { cause } : {}, ...details === void 0 ? {} : { details }, detailsKeys: details && typeof details === "object" ? Object.keys(details).sort() : [], ...value.docsUrl === void 0 ? {} : { docsUrl: String(value.docsUrl) }, ...nativeSerialized === void 0 ? {} : { serialized: nativeSerialized } };
};
var equal = (a, b) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || !a || !b || typeof a !== "object") return false;
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, index) => key === bk[index] && equal(a[key], b[key]));
};
var compareBoundaryShape = (expected, actual) => {
  const fields = ["name", "className", "tag", "code", "message", "summary", "hasCause", "details", "detailsKeys", "docsUrl", "serialized"];
  const differences = fields.filter((field) => !equal(expected[field], actual[field])).map((field) => field + " differs");
  if (!equal(expected.cause, actual.cause)) differences.push("cause differs");
  return differences;
};

// src/probes/contractProbe.ts
var defaultSerialize = (value) => {
  if (!(value instanceof Error)) return value;
  const record = value;
  return JSON.parse(JSON.stringify({
    name: value.name,
    message: value.message,
    ...Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]))
  }));
};
var contractProbe = async (name, production, simulated, options = {}) => {
  let expected;
  let actual;
  let productionThrew = false;
  let simulationThrew = false;
  try {
    expected = await production();
  } catch (error) {
    productionThrew = true;
    expected = error;
  }
  try {
    actual = await simulated();
  } catch (error) {
    simulationThrew = true;
    actual = error;
  }
  const expectedShape = boundaryShape(expected, (options.serializeProduction ?? defaultSerialize)(expected));
  const actualShape = boundaryShape(actual, (options.serializeSimulation ?? defaultSerialize)(actual));
  const differences = [
    ...productionThrew === simulationThrew ? [] : ["production and simulation must both throw or both succeed"],
    ...compareBoundaryShape(expectedShape, actualShape)
  ];
  return { name, passed: differences.length === 0, expected: expectedShape, actual: actualShape, differences };
};

// src/index.ts
init_CleanupScope();
init_leakAssertions();

// src/assertions/effectAssertions.ts
var ExactlyOnceUnsupportedError = class extends Error {
  code = "EXACTLY_ONCE_UNSUPPORTED";
  constructor() {
    super("Exactly-once external effects are unsupported; use atLeastOnce(), idempotencyKey(), or journalCas().");
    this.name = "ExactlyOnceUnsupportedError";
  }
};
var expectEffect = (name) => ({ name, exactlyOnce: () => {
  throw new ExactlyOnceUnsupportedError();
}, atLeastOnce: () => ({ name, guarantee: "at-least-once" }), idempotencyKey: (key) => ({ name, key, guarantee: "idempotency-key" }), journalCas: () => ({ name, guarantee: "journal-cas" }) });

// src/replay/firstDivergence.ts
var firstField = (left, right) => {
  if (Object.is(left, right)) return void 0;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return "value";
  const keys = [.../* @__PURE__ */ new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.find((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
};
var firstDivergence = (left, right) => {
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const field = firstField(left[i], right[i]);
    if (field !== void 0 || left[i] === void 0 !== (right[i] === void 0)) {
      const leftIndex = left[i]?.data?.controlIndex;
      const rightIndex = right[i]?.data?.controlIndex;
      const controlIndex = typeof leftIndex === "number" ? leftIndex : typeof rightIndex === "number" ? rightIndex : void 0;
      return { index: i, sequence: left[i]?.seq ?? right[i]?.seq ?? i, ...controlIndex === void 0 ? {} : { controlIndex }, field, left: left[i], right: right[i], message: `trace divergence at event ${i}${controlIndex === void 0 ? "" : ` (control ${controlIndex})`}${field ? ` (${field})` : ""}` };
    }
  }
  return null;
};

// src/replay/shrink.ts
init_compile();
var controlsValid = (ast, controls) => {
  const steps = new Set(ast.steps.map((step2) => step2.id));
  const faults = new Set(ast.faults.map((fault2) => fault2.id));
  const barriers = new Set(ast.barriers.map((barrier2) => barrier2.id));
  return controls.every((control) => (control.type !== "pin-interleaving" || steps.has(control.choice)) && (control.type !== "task-restart" || steps.has(control.step)) && (control.type !== "inject-fault" || faults.has(control.fault)) && (control.type !== "release-barrier" || barriers.has(control.barrier)) && (control.type !== "resolve-effect" || steps.has(control.effect.split(":", 1)[0])));
};
var removeStep = (ast, id) => {
  const referenced = new Set(ast.steps.flatMap((step2) => step2.dependsOn));
  if (referenced.has(id) || ast.barriers.some((barrier2) => barrier2.parties.includes(id))) return ast;
  return { ...ast, steps: ast.steps.filter((step2) => step2.id !== id) };
};
var shrink = async (ast, controls, failure, options = {}) => {
  const max = Math.max(0, options.maxCandidates ?? 100);
  let tried = 0;
  let current = ast;
  let currentControls = [...controls];
  let changed = true;
  while (changed && tried < max) {
    changed = false;
    for (const step2 of [...current.steps]) {
      if (tried >= max || current.steps.length <= 1) break;
      const candidate = removeStep(current, step2.id);
      const candidateControls = currentControls.filter((control) => (control.type !== "pin-interleaving" || control.choice !== step2.id) && (control.type !== "task-restart" || control.step !== step2.id));
      tried++;
      if (!compileScenario(candidate).ok || !controlsValid(candidate, candidateControls)) continue;
      if (await failure(candidate, candidateControls)) {
        current = candidate;
        currentControls = candidateControls;
        changed = true;
        break;
      }
    }
  }
  for (let i = 0; i < currentControls.length && tried < max; i++) {
    const candidateControls = currentControls.filter((_, index) => index !== i);
    tried++;
    if (!controlsValid(current, candidateControls)) continue;
    if (await failure(current, candidateControls)) {
      currentControls = candidateControls;
      i = -1;
    }
  }
  return { ast: current, controls: currentControls, candidatesTried: tried };
};

// src/adapters/realDbAdapter.ts
init_Harness();
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Effect as Effect5 } from "effect";
var realDbAdapter = (options) => {
  const productionOperations = /* @__PURE__ */ new Set(["claimAttemptCompletion", "claimRunForResume", "heartbeatRun", "completeRun", "requestRunCancel", "claimRunCancellation", "heartbeatAttempt"]);
  let resource;
  const runDb = async (value) => {
    if (value && typeof value.then === "function") return await value;
    if (value && typeof value.pipe === "function") return Effect5.runPromise(value);
    return value;
  };
  return registerTrustedAdapter({
    identity: options.identity ?? "real-db:sqlite",
    verifiedProductionIdentity: "@smithers-orchestrator/db/adapter:SmithersDb",
    supportedCutPoints: /* @__PURE__ */ new Set([
      "completion-cas:after-task",
      "completion-cas:after-journal-before-ack",
      "resume:before-task",
      "heartbeat:during-task",
      "lease:during-task",
      "cancellation:during-task"
    ]),
    admissionProbe: async () => {
      resource = await options.open();
      if (!(resource instanceof SmithersDb) || !resource.db || typeof resource.insertRun !== "function" || typeof resource.heartbeatRun !== "function" || typeof resource.close !== "function") {
        throw Object.assign(new Error("real-db adapter requires a live SmithersDb backed by Bun SQLite; declarations and echo objects are not proof"), { code: "ADMISSION_FAILED" });
      }
      try {
        const sqlite = resource.db.$client ?? resource.db;
        sqlite.query("SELECT 1").get();
      } catch (cause) {
        throw Object.assign(new Error("real-db admission could not execute SQLite"), { code: "ADMISSION_FAILED", cause });
      }
      const id = `testing-admission-${crypto.randomUUID()}`;
      await runDb(resource.insertRun({ runId: id, workflowName: "testing-framework", status: "running", createdAtMs: Date.now(), startedAtMs: Date.now(), heartbeatAtMs: null, runtimeOwnerId: "testing-framework" }));
      await runDb(resource.heartbeatRun(id, "testing-framework", Date.now()));
      const rows = await runDb(resource.listRuns(100, void 0, "testing-framework"));
      if (!rows.some((row) => row.runId === id)) throw Object.assign(new Error("real-db admission write was not durably readable"), { code: "ADMISSION_FAILED" });
    },
    cleanup: async () => {
      if (resource?.close) await resource.close();
      if (resource?.db) {
        try {
          resource.db.query("SELECT 1");
          throw Object.assign(new Error("CLEANUP_LEAK: database handle remained open after adapter cleanup"), { code: "CLEANUP_LEAK" });
        } catch (error) {
          if (error.code === "CLEANUP_LEAK") throw error;
        }
      }
      resource = void 0;
    },
    runStep: async (operation, ...args) => {
      if (!resource) throw new Error("REAL_DB_NOT_ADMITTED");
      const direct = resource[String(operation)];
      if (typeof direct === "function") return runDb(direct.apply(resource, args));
      if (productionOperations.has(String(operation))) throw Object.assign(new Error(`REAL_DB_OPERATION_UNAVAILABLE:${String(operation)} requires the admitted SmithersDb production method`), { code: "ADMISSION_FAILED" });
      const fn = resource.operations?.[String(operation)];
      if (!fn) throw new Error(`REAL_DB_OPERATION_UNAVAILABLE:${String(operation)}`);
      return fn.apply(resource, args);
    },
    injectFault: async (fault2) => {
      if (!resource) throw new Error("REAL_DB_NOT_ADMITTED");
      const operation = resource.operations?.[`${fault2.operation}:${fault2.phase}`];
      if (!operation) throw Object.assign(new Error(`REAL_DB_FAULT_UNAVAILABLE:${fault2.operation}:${fault2.phase}`), { code: "ADMISSION_FAILED" });
      await operation(fault2);
    }
  }, "integration-real-db");
};

// src/adapters/realDbCutPoints.ts
import { Effect as Effect6 } from "effect";
var resolve2 = async (value) => {
  if (value && typeof value.pipe === "function") return Effect6.runPromise(value);
  return await value;
};
var realDbCutPoints = (db) => Object.freeze({
  claimAttemptCompletion: (...args) => resolve2(db.claimAttemptCompletion(...args)),
  claimRunForResume: (...args) => resolve2(db.claimRunForResume(...args)),
  heartbeatRun: (...args) => resolve2(db.heartbeatRun(...args)),
  completeRun: (...args) => resolve2(db.completeRun(...args)),
  requestRunCancel: (...args) => resolve2(db.requestRunCancel(...args)),
  claimRunCancellation: (...args) => resolve2(db.claimRunCancellation(...args)),
  heartbeatAttempt: (...args) => resolve2(db.heartbeatAttempt(...args))
});

// src/adapters/realProcessAdapter.ts
init_Harness();
var exited = (child, budgetMs = 1e3) => new Promise((resolve3) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve3();
  let timer;
  const done = () => {
    if (timer) clearTimeout(timer);
    resolve3();
  };
  child.once("exit", done);
  timer = setTimeout(done, budgetMs);
});
var realProcessAdapter = (options) => {
  let resource;
  const tracked = /* @__PURE__ */ new Set();
  const nonces = /* @__PURE__ */ new Set();
  const challenge = () => {
    const nonce = crypto.randomUUID();
    nonces.add(nonce);
    return nonce;
  };
  return registerTrustedAdapter({
    identity: options.identity ?? "real-process:child",
    verifiedProductionIdentity: "smithers-engine:runWorkflow-child",
    supportedCutPoints: /* @__PURE__ */ new Set(["resume:during-task"]),
    admissionProbe: async () => {
      const nonce = challenge();
      resource = await options.spawn(nonce);
      tracked.add(resource);
      const args = resource.child?.spawnargs ?? [];
      const productionRunner = args.some((arg) => /(?:^|\/)engineChildRunner\.tsx?$/.test(arg));
      const response = await resource.handshake(nonce);
      if (!resource.child || resource.child.pid !== resource.pid || resource.pid === process.pid || !Number.isInteger(resource.pid) || resource.pid <= 0 || !productionRunner || response !== nonce || resource.healthy && !await resource.healthy()) throw Object.assign(new Error("real process failed admission: the child did not prove the production runWorkflow protocol"), { code: "ADMISSION_FAILED" });
      try {
        process.kill(resource.pid, 0);
      } catch (cause) {
        throw Object.assign(new Error("real process is not a live production child"), { code: "ADMISSION_FAILED", cause });
      }
    },
    cleanup: async () => {
      for (const childResource of tracked) {
        if (childResource.child.exitCode === null && childResource.child.signalCode === null) await childResource.kill("SIGKILL");
        await exited(childResource.child);
        await childResource.close();
        if (childResource.child.exitCode === null && childResource.child.signalCode === null) throw Object.assign(new Error(`CLEANUP_LEAK: child/${childResource.pid}`), { code: "CLEANUP_LEAK" });
      }
      tracked.clear();
      resource = void 0;
    },
    runStep: async (operation, ...args) => {
      if (!resource) throw new Error("REAL_PROCESS_NOT_ADMITTED");
      if (operation === "kill") return resource.kill(String(args[0] ?? "SIGKILL"));
      if (operation !== "runWorkflow") throw Object.assign(new Error(`REAL_PROCESS_OPERATION_UNAVAILABLE:${String(operation)}`), { code: "ADMISSION_FAILED" });
      return resource.pid;
    },
    injectFault: async (fault2) => {
      if (!resource) throw new Error("REAL_PROCESS_NOT_ADMITTED");
      if (fault2.operation !== "resume" || fault2.phase !== "during-task") throw Object.assign(new Error(`REAL_PROCESS_FAULT_UNAVAILABLE:${fault2.operation}:${fault2.phase}`), { code: "ADMISSION_FAILED" });
      await resource.kill("SIGKILL");
      await exited(resource.child);
      if (resource.child.signalCode !== "SIGKILL") throw Object.assign(new Error("real process replacement requires observed SIGKILL terminal event"), { code: "ADMISSION_FAILED", details: { pid: resource.pid, signalCode: resource.child.signalCode } });
      if (!resource.resume) throw Object.assign(new Error("REAL_PROCESS_RESUME_UNAVAILABLE"), { code: "ADMISSION_FAILED" });
      const nonce = challenge();
      const resumed = await resource.resume(nonce);
      if (resumed.pid === resource.pid) throw Object.assign(new Error("real process resume must create a distinct child"), { code: "ADMISSION_FAILED" });
      if (await resumed.handshake(nonce) !== nonce) throw Object.assign(new Error("resumed process failed nonce challenge"), { code: "ADMISSION_FAILED" });
      tracked.add(resumed);
      resource = resumed;
    }
  }, "e2e-real-process");
};
export {
  BoundedWaitError,
  CanonicalizeError,
  CleanupScope,
  ControlBus,
  EffectLedger,
  ExactlyOnceUnsupportedError,
  JournalModel,
  SeededScheduler,
  SimulationError,
  TraceCollector,
  VirtualClock,
  ambiguity,
  assertNoLeaks,
  auto,
  barrier,
  boundaryShape,
  boundedWait,
  canonicalize,
  compareBoundaryShape,
  compileScenario,
  contractProbe,
  cutPoint,
  dryRun,
  e2eDescriptor,
  e2eHarness,
  expectEffect,
  extension,
  fakeAgent,
  fault,
  firstDivergence,
  integrationHarness,
  isAuto,
  isOpaqueEffect,
  loadReplayBundle,
  makeHarness,
  makeReplayBundle,
  mediatedEffect,
  opaqueEffect,
  realDbAdapter,
  realDbCutPoints,
  realProcessAdapter,
  renderPromptToText as renderPrompt,
  renderWorkflow,
  replayBundle,
  replayIdentity,
  requiredCapabilities,
  runScenario,
  runTask,
  scenario,
  serializeReplayBundle,
  shrink,
  simMatchers,
  simulate,
  step,
  toHaveExecuted,
  toHaveExecutedInOrder,
  toHaveFinished,
  unitSimHarness
};
