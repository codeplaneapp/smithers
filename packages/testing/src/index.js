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
      for (const child of Object.values(value))
        if (child && typeof child === "object" && !Object.isFrozen(child)) freezeScenario(child);
      return Object.freeze(value);
    };
  }
});

// src/scenario/statelessSource.ts
var RESERVED, UNPROVABLE, SIMPLE_PARAMS, NUMERIC_LITERALS, COERCION_CHARS, BLOCK_KEYWORDS, isIdentStart, isIdentPart, stripLiterals, matchingParen, nextNonSpace, prevNonSpace, wordEndingAt, parseOuterForm, provablyStatelessSource;
var init_statelessSource = __esm({
  "src/scenario/statelessSource.ts"() {
    "use strict";
    RESERVED = /* @__PURE__ */ new Set([
      "return",
      "if",
      "else",
      "for",
      "while",
      "do",
      "switch",
      "case",
      "default",
      "break",
      "continue",
      "typeof",
      "void",
      "try",
      "catch",
      "finally",
      "debugger",
      "enum",
      "const",
      "let",
      "var",
      "true",
      "false",
      "null"
    ]);
    UNPROVABLE = /* @__PURE__ */ new Set([
      "this",
      "arguments",
      "class",
      "super",
      "import",
      "export",
      "with",
      "eval",
      "function",
      // Coercion- and protocol-reaching reserved words: `await` adopts thenables,
      // `new` invokes constructors, `in`/`instanceof` walk prototype protocols,
      // `delete` mutates, `throw`/`yield` hand values to serialization boundaries
      // outside the grammar. `async` is contextual but only ever introduces an
      // async binder here, so it fails closed too.
      "await",
      "async",
      "new",
      "delete",
      "in",
      "instanceof",
      "throw",
      "yield"
    ]);
    SIMPLE_PARAMS = /^\s*(?:[A-Za-z_$][\w$]*\s*(?:,\s*[A-Za-z_$][\w$]*\s*)*,?\s*)?$/;
    NUMERIC_LITERALS = /(?<![\w$.])(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/g;
    COERCION_CHARS = /* @__PURE__ */ new Set(["+", "-", "*", "%", "~", "^", "<", ">", "[", "]"]);
    BLOCK_KEYWORDS = /* @__PURE__ */ new Set(["else", "do", "try", "finally", "catch"]);
    isIdentStart = (ch) => /[A-Za-z_$]/.test(ch);
    isIdentPart = (ch) => /[\w$]/.test(ch);
    stripLiterals = (source) => {
      let out = "";
      for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (ch === "`") return null;
        if (ch === '"' || ch === "'") {
          out += "0";
          for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === "\\") i++;
          continue;
        }
        if (ch === "/" && source[i + 1] === "/") {
          for (; i < source.length && source[i] !== "\n"; i++) ;
          out += " ";
          continue;
        }
        if (ch === "/" && source[i + 1] === "*") {
          i += 2;
          for (; i + 1 < source.length && !(source[i] === "*" && source[i + 1] === "/"); i++) ;
          i++;
          out += " ";
          continue;
        }
        out += ch;
      }
      return out;
    };
    matchingParen = (text, openIndex) => {
      let depth = 0;
      for (let i = openIndex; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) return i;
      }
      return -1;
    };
    nextNonSpace = (text, index) => {
      let i = index;
      while (i < text.length && /\s/.test(text[i])) i++;
      return i;
    };
    prevNonSpace = (text, index) => {
      let i = index;
      while (i >= 0 && /\s/.test(text[i])) i--;
      return i;
    };
    wordEndingAt = (text, lastIndex) => {
      let start = lastIndex;
      while (start > 0 && isIdentPart(text[start - 1])) start--;
      return text.slice(start, lastIndex + 1);
    };
    parseOuterForm = (stripped) => {
      const text = stripped.trim();
      if (text.startsWith("function")) {
        let cursor = 8;
        cursor = nextNonSpace(text, cursor);
        if (text[cursor] === "*") cursor = nextNonSpace(text, cursor + 1);
        if (isIdentStart(text[cursor] ?? "")) {
          while (cursor < text.length && isIdentPart(text[cursor])) cursor++;
          cursor = nextNonSpace(text, cursor);
        }
        if (text[cursor] !== "(") return null;
        const close = matchingParen(text, cursor);
        if (close < 0) return null;
        const paramsText = text.slice(cursor + 1, close);
        if (!SIMPLE_PARAMS.test(paramsText)) return null;
        const bodyStart = nextNonSpace(text, close + 1);
        if (text[bodyStart] !== "{") return null;
        return { params: paramsText.match(/[A-Za-z_$][\w$]*/g) ?? [], body: text.slice(bodyStart), blockBody: true };
      }
      if (text.startsWith("(")) {
        const close = matchingParen(text, 0);
        if (close < 0) return null;
        const paramsText = text.slice(1, close);
        if (!SIMPLE_PARAMS.test(paramsText)) return null;
        const arrow = nextNonSpace(text, close + 1);
        if (text.slice(arrow, arrow + 2) !== "=>") return null;
        const body = text.slice(nextNonSpace(text, arrow + 2));
        return { params: paramsText.match(/[A-Za-z_$][\w$]*/g) ?? [], body, blockBody: body.startsWith("{") };
      }
      if (isIdentStart(text[0] ?? "")) {
        let cursor = 0;
        while (cursor < text.length && isIdentPart(text[cursor])) cursor++;
        const param = text.slice(0, cursor);
        if (param === "async") return null;
        const arrow = nextNonSpace(text, cursor);
        if (text.slice(arrow, arrow + 2) !== "=>") return null;
        const body = text.slice(nextNonSpace(text, arrow + 2));
        return { params: [param], body, blockBody: body.startsWith("{") };
      }
      return null;
    };
    provablyStatelessSource = (rawSource) => {
      const stripped = stripLiterals(rawSource);
      if (stripped === null) return false;
      if (stripped.includes("\\") || !/^[\t\n\r\x20-\x7E]*$/.test(stripped)) return false;
      if (stripped.includes("/")) return false;
      const outer = parseOuterForm(stripped);
      if (outer === null) return false;
      const locals = new Set(outer.params);
      const body = outer.body;
      const neutralized = body.replace(NUMERIC_LITERALS, "0");
      if (neutralized.includes(".")) return false;
      for (let i = 0; i < neutralized.length; i++) {
        const ch = neutralized[i];
        if (COERCION_CHARS.has(ch)) return false;
        if (ch === "!") {
          let j = i;
          while (neutralized[j + 1] === "=") j++;
          const equalsRun = j - i;
          if (equalsRun !== 0 && equalsRun !== 2) return false;
          i = j;
          continue;
        }
        if (ch === "=") {
          if (neutralized[i + 1] === ">") {
            i++;
            continue;
          }
          let j = i;
          while (neutralized[j + 1] === "=") j++;
          const runLength = j - i + 1;
          if (!(runLength === 3 || runLength === 1)) return false;
          i = j;
          continue;
        }
        if (ch === "&" || ch === "|") {
          if (neutralized[i + 1] !== ch) return false;
          i++;
          continue;
        }
        if (ch === "{") {
          const prevIndex = prevNonSpace(neutralized, i - 1);
          if (prevIndex < 0) continue;
          const prev = neutralized[prevIndex];
          if (prev === ")" || prev === "{" || prev === "}" || prev === ";") continue;
          if (prev === ">" && neutralized[prevIndex - 1] === "=") continue;
          if (isIdentPart(prev) && BLOCK_KEYWORDS.has(wordEndingAt(neutralized, prevIndex))) continue;
          return false;
        }
      }
      if (body.includes("=>")) {
        if (/\b(?:var|let|const)\b/.test(body)) return false;
      } else {
        let depth = 0;
        for (let i = 0; i < body.length; i++) {
          const ch = body[i];
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          else if (isIdentStart(ch) && (i === 0 || !isIdentPart(body[i - 1]))) {
            let end = i;
            while (end < body.length && isIdentPart(body[end])) end++;
            const word = body.slice(i, end);
            const headDeclaration = body[prevNonSpace(body, i - 1)] === "(";
            if (word === "var" || (word === "const" || word === "let") && !headDeclaration && depth === (outer.blockBody ? 1 : 0)) {
              const nameStart = nextNonSpace(body, end);
              if (isIdentStart(body[nameStart] ?? "")) {
                let nameEnd = nameStart;
                while (nameEnd < body.length && isIdentPart(body[nameEnd])) nameEnd++;
                if (word === "var" || body[nextNonSpace(body, nameEnd)] === "=") locals.add(body.slice(nameStart, nameEnd));
              }
            }
            i = end - 1;
          }
        }
      }
      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === "(") {
          const close = matchingParen(body, i);
          if (close < 0) return false;
          const after = nextNonSpace(body, close + 1);
          if (body.slice(after, after + 2) === "=>") {
            if (body.slice(i + 1, close).trim() !== "") return false;
          }
          continue;
        }
        if (!isIdentStart(ch) || i > 0 && isIdentPart(body[i - 1])) continue;
        let end = i;
        while (end < body.length && isIdentPart(body[end])) end++;
        const word = body.slice(i, end);
        i = end - 1;
        if (UNPROVABLE.has(word)) return false;
        if (RESERVED.has(word)) {
          if (body[nextNonSpace(body, end)] === ".") return false;
          continue;
        }
        if (locals.has(word)) continue;
        return false;
      }
      return true;
    };
  }
});

// src/scenario/builder.ts
var intrinsicFunctionToString, runnerSource, runners, runnersByBinding, validRunnerBinding, stepRunner, step, barrier, fault, extension, scenario;
var init_builder = __esm({
  "src/scenario/builder.ts"() {
    "use strict";
    init_ast();
    init_statelessSource();
    intrinsicFunctionToString = Function.prototype.toString;
    runnerSource = (runner) => intrinsicFunctionToString.call(runner);
    runners = /* @__PURE__ */ new WeakMap();
    runnersByBinding = /* @__PURE__ */ new Map();
    validRunnerBinding = (binding) => typeof binding === "string" && binding.trim().length > 0;
    stepRunner = (stepValue) => runners.get(stepValue) ?? (validRunnerBinding(stepValue.runnerBinding) ? runnersByBinding.get(stepValue.runnerBinding) : void 0);
    step = (id, options = {}) => {
      const explicitBinding = options.runnerBinding !== void 0;
      if (explicitBinding && !validRunnerBinding(options.runnerBinding)) {
        throw Object.assign(
          new Error(
            `RUNNER_BINDING_INVALID: runnerBinding must be a non-empty stable string (step ${id}); an empty, whitespace-only, or non-string binding cannot name one behavior across processes and would strand its executable outside the canonical AST`
          ),
          { code: "RUNNER_BINDING_INVALID", details: { step: id, runnerBinding: options.runnerBinding } }
        );
      }
      if (explicitBinding && options.runnerBinding.startsWith("anonymous:")) {
        throw Object.assign(
          new Error(
            `RUNNER_BINDING_CONFLICT: the anonymous: namespace is retired framework-issued identity; provide a caller-owned runnerBinding`
          ),
          { code: "RUNNER_BINDING_CONFLICT", details: { runnerBinding: options.runnerBinding, explicitBinding } }
        );
      }
      if (options.run && !explicitBinding) {
        const source = runnerSource(options.run);
        if (!provablyStatelessSource(source)) {
          throw Object.assign(
            new Error(
              "RUNNER_BINDING_AMBIGUOUS: callback statelessness is not provable from source; provide an explicit stable runnerBinding"
            ),
            { code: "RUNNER_BINDING_AMBIGUOUS" }
          );
        }
        throw Object.assign(
          new Error(
            `RUNNER_BINDING_REQUIRED: anonymous executable identities are retired \u2014 every run callback requires an explicit caller-supplied stable runnerBinding (step ${id}); the caller owns keeping the binding pointed at one behavior across processes`
          ),
          { code: "RUNNER_BINDING_REQUIRED", details: { step: id } }
        );
      }
      const runnerBinding = options.runnerBinding;
      if (options.run && runnerBinding !== void 0) {
        const prior = runnersByBinding.get(runnerBinding);
        if (prior && prior !== options.run) {
          throw Object.assign(
            new Error(
              `RUNNER_BINDING_CONFLICT: ${runnerBinding} names multiple executables; provide an explicit stable runnerBinding`
            ),
            { code: "RUNNER_BINDING_CONFLICT", details: { runnerBinding, explicitBinding } }
          );
        }
      }
      const value = freezeScenario({
        kind: "step",
        id,
        ...options.input === void 0 ? {} : { input: options.input },
        dependsOn: [...options.dependsOn ?? []],
        capabilities: [...options.capabilities ?? []],
        ...options.extension ? { extension: options.extension } : {},
        ...runnerBinding === void 0 ? {} : { runnerBinding }
      });
      const executable = options.run;
      if (executable) {
        runners.set(value, executable);
        if (runnerBinding !== void 0 && !runnersByBinding.has(runnerBinding))
          runnersByBinding.set(runnerBinding, executable);
      }
      return value;
    };
    barrier = (id, parties, budget = 100) => freezeScenario({ kind: "barrier", id, parties: [...parties], budget });
    fault = (id, phase, operation, outcome) => freezeScenario({ kind: "fault", id, phase, operation, ...outcome === void 0 ? {} : { outcome } });
    extension = (name, value) => freezeScenario({ kind: "extension", name, value });
    scenario = (name, options = {}) => freezeScenario({
      version: 1,
      name,
      ...options.seed === void 0 ? {} : { seed: options.seed },
      steps: [...options.steps ?? []],
      barriers: [...options.barriers ?? []],
      faults: [...options.faults ?? []],
      extensions: [...options.extensions ?? []]
    });
  }
});

// src/harness/capabilities.ts
var admitCapabilities, requiredCapabilities;
var init_capabilities = __esm({
  "src/harness/capabilities.ts"() {
    "use strict";
    admitCapabilities = (harness, requested, policy = "fail") => requested.map(
      (capability) => harness.capabilities.has(capability) ? { kind: "supported", harness: harness.name, capability } : {
        kind: policy === "skip" ? "capability-skip" : "capability-failure",
        harness: harness.name,
        capability,
        hint: "Choose a harness that declares this capability."
      }
    );
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
        if (ids.has(step2.id))
          diagnostics.push({ code: "DUPLICATE_STEP_ID", message: `duplicate step id ${step2.id}`, node: step2.id });
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
      for (const step2 of ast.steps)
        if (step2.extension && !registeredExtensions.has(step2.extension))
          diagnostics.push({
            code: "UNREGISTERED_STEP_EXTENSION",
            message: `step ${step2.id} references extension ${step2.extension} with no executor`,
            node: step2.id
          });
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
      const result = Array.isArray(value) ? "[" + value.map((item, i) => encode(item, path + "[" + i + "]", seen)).join(",") + "]" : "{" + Object.keys(value).sort().map(
        (key) => JSON.stringify(key) + ":" + encode(value[key], path + "." + key, seen)
      ).join(",") + "}";
      seen.delete(value);
      return result;
    };
    canonicalize = (value) => encode(value);
  }
});

// src/scenario/replayIdentity.ts
import { createHash } from "crypto";
var replayIdentity;
var init_replayIdentity = __esm({
  "src/scenario/replayIdentity.ts"() {
    "use strict";
    init_canonicalize();
    replayIdentity = (input) => "ri1:" + createHash("sha256").update(canonicalize({ ast: input.ast, seed: input.seed, controlLog: input.controlLog ?? [] })).digest("hex");
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
function integrationHarness(config = {}) {
  return makeHarness("integration-real-db", config);
}
function e2eHarness(config = {}) {
  return makeHarness("e2e-real-process", config);
}
var trustedAdapters, registerTrustedAdapter, trustedAdapterKind, unitSimHarness;
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
    unitSimHarness = (config = {}) => makeHarness("unit-sim", config);
  }
});

// src/kernel/boundary.ts
import { Cause, Effect as Effect3, Exit, Fiber, Option, Result } from "effect";
var toHarnessError, squashCause, runAtBoundaryFork;
var init_boundary = __esm({
  "src/kernel/boundary.ts"() {
    "use strict";
    toHarnessError = (error) => {
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
    squashCause = (cause) => {
      const failure2 = Cause.findErrorOption(cause);
      if (Option.isSome(failure2)) return failure2.value;
      const defect = Cause.findDefect(cause);
      return Result.isSuccess(defect) ? defect.success : new Error("kernel program failed");
    };
    runAtBoundaryFork = (program) => {
      const fiber = Effect3.runFork(Effect3.exit(program));
      const promise = Effect3.runPromise(Fiber.join(fiber)).then((exit) => {
        if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
        return { ok: false, error: toHarnessError(squashCause(exit.cause)) };
      });
      return { promise, interrupt: () => Effect3.runPromise(Fiber.interrupt(fiber)) };
    };
  }
});

// src/kernel/KernelRuntime.ts
import { Context, Effect as Effect4, Fiber as Fiber2, Layer, Result as Result2 } from "effect";
var KernelRuntimeService, kernelLayer, makeKernel;
var init_KernelRuntime = __esm({
  "src/kernel/KernelRuntime.ts"() {
    "use strict";
    init_ControlBus();
    init_SeededScheduler();
    init_TraceCollector();
    init_VirtualClock();
    KernelRuntimeService = class extends Context.Service()("@smithers/testing/KernelRuntime") {
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
        runReadySet: (tasks) => Effect4.gen(function* () {
          const fresh = tasks.filter(({ stepId }) => !active.has(stepId));
          for (const { stepId, effect } of fresh) active.set(stepId, yield* Effect4.forkChild(effect));
          if (!active.size) throw new Error("KERNEL_NO_ACTIVE_FIBERS");
          const winner = yield* Effect4.raceAll(
            [...active.entries()].map(
              ([stepId, fiber]) => Fiber2.join(fiber).pipe(
                Effect4.result,
                Effect4.map((exit) => ({ stepId, exit }))
              )
            )
          );
          active.delete(winner.stepId);
          if (Result2.isFailure(winner.exit)) {
            yield* Effect4.all([...active.values()].map((fiber) => Fiber2.interrupt(fiber)));
            active.clear();
            return yield* Effect4.fail(winner.exit.failure);
          }
          return { stepId: winner.stepId, value: winner.exit.success };
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
      return {
        next: (prefix = "id") => {
          state = mix(state + 2654435769);
          return prefix + "-" + state.toString(36).padStart(7, "0");
        },
        snapshot: () => state
      };
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
            new Promise((resolve3) => setTimeout(resolve3, Math.max(0, deadline - Date.now())))
          ]);
        }
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
      const leaks = [...scope.pending(), ...scope.liveResources(), ...extra];
      if (leaks.length)
        throw Object.assign(new Error(`CLEANUP_LEAK: ${leaks.map((x) => `${x.kind}/${x.id}`).join(", ")}`), {
          code: "CLEANUP_LEAK",
          details: { leaks }
        });
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
  }
});

// src/durability/ambiguity.ts
var ambiguity;
var init_ambiguity = __esm({
  "src/durability/ambiguity.ts"() {
    "use strict";
    ambiguity = (outcome, details = {}) => Object.freeze({
      outcome,
      guaranteed: outcome === "journal-applied-ack-missing" ? "journal-cas-only" : "at-least-once",
      details: Object.freeze({ ...details })
    });
  }
});

// src/runScenario.ts
var runScenario_exports = {};
__export(runScenario_exports, {
  runScenario: () => runScenario
});
import { Effect as Effect5, Fiber as Fiber3 } from "effect";
var faultFor, dbOperationKind, processOperationKind, faultError, adapterFailure, settleKernel, runScenario;
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
    init_canonicalize();
    faultFor = (faults, operation, phase) => faults.find((fault2) => fault2.operation === operation && fault2.phase === phase);
    dbOperationKind = (name) => {
      const base = name.replace(/#\d+$/, "");
      if (base === "claimAttemptCompletion" || base === "completeRun") return "completion-cas";
      if (base === "claimRunForResume") return "resume";
      if (base === "heartbeatRun" || base === "heartbeatAttempt") return "heartbeat";
      if (base === "requestRunCancel" || base === "claimRunCancellation") return "cancellation";
      return void 0;
    };
    processOperationKind = (name) => name.replace(/#\d+$/, "") === "runWorkflow" ? "resume" : void 0;
    faultError = (fault2) => Object.assign(new Error(`fault injected at ${fault2.id}`), {
      code: "DURABILITY_FAULT_INJECTED",
      details: fault2,
      fidelity: "simulation"
    });
    adapterFailure = (adapter, cause) => {
      if (!adapter) return cause;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return Object.assign(error, {
        fidelity: "native",
        ...adapter.serializeError ? { serialized: adapter.serializeError(cause) } : {}
      });
    };
    settleKernel = async (promise, kernel, budget) => {
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
        for (let microtask = 0; microtask < Math.min(64, Math.max(1, budget)); microtask++) await Promise.resolve();
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
    runScenario = async (ast, options = {}) => {
      const seed = options.seed ?? ast.seed ?? 0;
      const harness = options.harness ?? unitSimHarness();
      const kernel = makeKernel(seed, options.controlLog ?? []);
      const unboundRunner = ast.steps.filter(
        (step2) => (options.stepRunners?.[step2.id] !== void 0 || stepRunner(step2) !== void 0) && !validRunnerBinding(step2.runnerBinding)
      ).map((step2) => step2.id);
      const invalidBinding = ast.steps.filter((step2) => step2.runnerBinding !== void 0 && !validRunnerBinding(step2.runnerBinding)).map((step2) => step2.id);
      const retiredBinding = ast.steps.filter((step2) => typeof step2.runnerBinding === "string" && step2.runnerBinding.startsWith("anonymous:")).map((step2) => step2.id);
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
      const program = Effect5.gen(function* () {
        if (harness.adapter) {
          cleanup.register("harness", harness.name, harness.adapter.cleanup ?? (() => void 0));
          yield* Effect5.tryPromise({
            try: () => Promise.resolve(harness.adapter.admissionProbe()),
            catch: (cause) => Object.assign(new Error(`ADMISSION_FAILED: ${harness.name} did not admit its production system`), {
              code: "ADMISSION_FAILED",
              cause,
              details: { native: harness.adapter?.serializeError?.(cause) }
            })
          });
          for (const extension2 of ast.extensions) {
            const executor = harness.adapter.extensionExecutors?.[extension2.name];
            if (!executor)
              throw Object.assign(new Error(`UNREGISTERED_EXTENSION: ${extension2.name}`), {
                code: "UNREGISTERED_EXTENSION",
                details: { extension: extension2.name }
              });
            yield* Effect5.tryPromise({
              try: () => Promise.resolve(executor(extension2.name, extension2.value)),
              catch: (cause) => adapterFailure(harness.adapter, cause)
            });
            kernel.trace.emit({
              type: "adapter",
              id: extension2.name,
              data: { identity: harness.adapter.identity, extension: extension2.name, executed: true }
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
            promise: new Promise((resolve3) => {
              release = resolve3;
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
          for (const barrier2 of ast.barriers) {
            const arrived = barrier2.parties.every((party) => parked.has(party));
            if (arrived && !releasedBarriers.has(barrier2.id)) {
              const release = runtimeKernel.controls.peek()?.type === "release-barrier" ? runtimeKernel.controls.takeNext("release-barrier") : void 0;
              if (release?.barrier === barrier2.id) {
                releasedBarriers.add(barrier2.id);
                for (const party of barrier2.parties) {
                  parked.delete(party);
                  completed.add(party);
                  if (parkedValues.has(party)) outputs[party] = parkedValues.get(party);
                  parkedValues.delete(party);
                }
                kernel.trace.emit({
                  type: "barrier",
                  id: ids.next(barrier2.id),
                  data: { state: "released", parties: barrier2.parties }
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
              (barrier2) => barrier2.parties.every((party) => parked.has(party)) && !releasedBarriers.has(barrier2.id)
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
            (selected) => Effect5.gen(function* () {
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
                  const invoke2 = () => {
                    const pending = settleKernel(Promise.resolve().then(operation), kernel, options.waitBudget ?? 1e4);
                    cleanup.track({ kind: "mediated-effect", id: effectId }, pending);
                    return pending;
                  };
                  const run = control?.outcome === "duplicate" ? invoke2().then(() => invoke2()).then((value2) => {
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
                  }) : invoke2();
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
                sleep: (ms) => new Promise((resolve3, reject) => {
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
                    finish(resolve3);
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
                yield* Effect5.tryPromise({
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
                yield* Effect5.tryPromise({ try: () => gate.promise, catch: (cause) => cause });
              }
              const injectFault = harness.adapter?.injectFault;
              const duringFault = ast.faults.find(
                (candidate) => candidate.phase === "during-task" && (candidate.operation === "task" || candidate.operation === "resume" || candidate.operation === "lease" || candidate.operation === "heartbeat" || candidate.operation === "cancellation")
              );
              if (harness.adapter?.runStep && harness.kind !== "unit-sim") {
                const productionOperation = harness.kind === "e2e-real-process" ? "runWorkflow" : selected.id;
                const canonicalOperation = productionOperation.replace(/#\d+$/, "");
                const mappedOperation = harness.kind === "integration-real-db" ? dbOperationKind(productionOperation) : harness.kind === "e2e-real-process" ? processOperationKind(productionOperation) : void 0;
                const fireAtTransition = (candidate, invoked, observedResult) => Effect5.gen(function* () {
                  if (controlledFault?.id === candidate.id) controlledFaultObserved = true;
                  const observation = injectFault ? yield* Effect5.tryPromise({
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
                productionValue = yield* Effect5.tryPromise({
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
              const runTask2 = () => {
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
                const child = yield* Effect5.forkChild(Effect5.tryPromise({ try: () => runTask2(), catch: (e) => e }));
                yield* Effect5.yieldNow;
                yield* Effect5.tryPromise({ try: () => Promise.resolve(), catch: (cause) => cause });
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
                    value = yield* Effect5.tryPromise({ try: () => runTask2(), catch: (e) => e });
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
              if (runner && !duringFault) value = yield* Effect5.tryPromise({ try: () => runTask2(), catch: (e) => e });
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
                if (runner) value = yield* Effect5.tryPromise({ try: () => runTask2(), catch: (e) => e });
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
      const execution = runAtBoundaryFork(program.pipe(Effect5.provide(kernelLayer(kernel))));
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
  }
});

// src/fakeAgent.ts
import { closeSync, constants as fsConstants, writeFileSync } from "fs";
import { lstat, mkdir, open, realpath } from "fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "path";

// src/schemaMock.ts
import { toJSONSchema } from "zod";
import { zodSchemaToJsonExample } from "@smithers-orchestrator/components/zod-to-example";
function stringForFormat(format) {
  switch (format) {
    case "email":
      return "test@example.com";
    case "uri":
    case "url":
      return "https://example.com";
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    case "date-time":
      return "2020-01-01T00:00:00.000Z";
    case "date":
      return "2020-01-01";
    case "time":
      return "00:00:00Z";
    case "ipv4":
      return "127.0.0.1";
    case "ipv6":
      return "::1";
    case "hostname":
      return "example.com";
    default:
      return "string";
  }
}
function nextRepresentable(value, direction) {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return direction === 1 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  let bits = view.getBigUint64(0);
  bits += (value >= 0 ? direction : -direction) === 1 ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}
function greatestCommonDivisor(left, right) {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left < 0n ? -left : left;
}
function integerStepFromMultiple(multiple) {
  const [mantissa, exponentText] = multiple.toString().toLowerCase().split("e");
  const exponent = Number(exponentText ?? 0);
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = `${whole}${fraction}`.replace(/^\+/, "");
  let numerator = BigInt(digits);
  let denominator = 1n;
  const scale = fraction.length - exponent;
  if (scale > 0) denominator = 10n ** BigInt(scale);
  else if (scale < 0) numerator *= 10n ** BigInt(-scale);
  const divisor = greatestCommonDivisor(numerator, denominator);
  return Number((numerator < 0n ? -numerator : numerator) / divisor);
}
function numberFromSchema(schema, integer) {
  let lower = schema.minimum ?? Number.NEGATIVE_INFINITY;
  let upper = schema.maximum ?? Number.POSITIVE_INFINITY;
  if (schema.exclusiveMinimum !== void 0) {
    lower = Math.max(
      lower,
      integer ? Math.floor(schema.exclusiveMinimum) + 1 : nextRepresentable(schema.exclusiveMinimum, 1)
    );
  }
  if (schema.exclusiveMaximum !== void 0) {
    upper = Math.min(
      upper,
      integer ? Math.ceil(schema.exclusiveMaximum) - 1 : nextRepresentable(schema.exclusiveMaximum, -1)
    );
  }
  if (integer) {
    lower = Math.ceil(lower);
    upper = Math.floor(upper);
  }
  const multiple = schema.multipleOf && schema.multipleOf > 0 ? Math.abs(schema.multipleOf) : integer ? 1 : null;
  if (multiple !== null) {
    if (integer) {
      const step2 = integerStepFromMultiple(multiple);
      if (!Number.isFinite(step2) || step2 <= 0) {
        throw new TypeError("JSON Schema multipleOf cannot produce a representable integer");
      }
      const firstMultiplier2 = Number.isFinite(lower) ? Math.ceil(lower / step2) : 0;
      const lastMultiplier2 = Number.isFinite(upper) ? Math.floor(upper / step2) : Infinity;
      const multiplier2 = firstMultiplier2 <= 0 && lastMultiplier2 >= 0 ? 0 : firstMultiplier2;
      const value2 = multiplier2 * step2;
      if (firstMultiplier2 > lastMultiplier2 || value2 < lower || value2 > upper || !Number.isInteger(value2)) {
        throw new TypeError("JSON Schema numeric constraints have no representable integer multiple");
      }
      return value2;
    }
    let firstMultiplier = Number.isFinite(lower) ? Math.ceil(lower / multiple) : 0;
    let lastMultiplier = Number.isFinite(upper) ? Math.floor(upper / multiple) : Infinity;
    if (Number.isFinite(lower) && (firstMultiplier - 1) * multiple >= lower) firstMultiplier -= 1;
    if (Number.isFinite(upper) && (lastMultiplier + 1) * multiple <= upper) lastMultiplier += 1;
    let multiplier = firstMultiplier <= 0 && lastMultiplier >= 0 ? 0 : firstMultiplier;
    let value = multiplier * multiple;
    if (firstMultiplier > lastMultiplier || value < lower || value > upper) {
      throw new TypeError("JSON Schema numeric constraints have no representable multiple");
    }
    return value;
  }
  if (lower > upper) throw new TypeError("JSON Schema numeric constraints describe an empty interval");
  if (lower <= 0 && upper >= 0) return 0;
  if (Number.isFinite(lower) && Number.isFinite(upper)) {
    const midpoint = lower + (upper - lower) / 2;
    return midpoint >= lower && midpoint <= upper ? midpoint : lower;
  }
  return Number.isFinite(lower) ? lower : Number.isFinite(upper) ? upper : 0;
}
function characterFromClass(source) {
  const negated = source.startsWith("^");
  const body = negated ? source.slice(1) : source;
  const candidates = ["a", "A", "0", "_", "-", " "];
  let expression;
  try {
    expression = new RegExp(`^[${source}]$`);
  } catch {
    return "a";
  }
  return candidates.find((candidate) => expression.test(candidate)) ?? (negated ? "a" : body[0] ?? "a");
}
function stringForPattern(pattern) {
  const source = pattern.replace(/^\^/, "").replace(/\$$/, "");
  const pieces = [];
  for (let index = 0; index < source.length; ) {
    let token = "";
    const char = source[index];
    if (char === "\\") {
      const escaped = source[index + 1];
      token = escaped === "d" ? "0" : escaped === "w" ? "a" : escaped === "s" ? " " : escaped ?? "";
      index += 2;
    } else if (char === "[") {
      const end = source.indexOf("]", index + 1);
      if (end < 0) return null;
      token = characterFromClass(source.slice(index + 1, end));
      index = end + 1;
    } else if (char === ".") {
      token = "a";
      index += 1;
    } else if ("()|".includes(char)) {
      index += 1;
      continue;
    } else {
      token = char;
      index += 1;
    }
    let count = 1;
    if (source[index] === "*") {
      count = 0;
      index += 1;
    } else if (source[index] === "?") {
      count = 0;
      index += 1;
    } else if (source[index] === "+") {
      index += 1;
    } else if (source[index] === "{") {
      const end = source.indexOf("}", index + 1);
      const minimum = end < 0 ? NaN : Number(source.slice(index + 1, end).split(",")[0]);
      if (!Number.isFinite(minimum)) return null;
      count = minimum;
      index = end + 1;
    }
    pieces.push(token.repeat(count));
  }
  const value = pieces.join("");
  try {
    return new RegExp(pattern).test(value) ? value : null;
  } catch {
    return null;
  }
}
function jsonSchemaExample(schema, depth = 0) {
  if (depth > 12) return null;
  if ("const" in schema) return schema.const;
  if ("default" in schema) return schema.default;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.enum?.length) return schema.enum[0];
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives?.length) return jsonSchemaExample(alternatives[0], depth + 1);
  if (schema.allOf?.length) {
    const values = schema.allOf.map((entry) => jsonSchemaExample(entry, depth + 1));
    if (values.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
      return Object.assign({}, ...values);
    }
    return values[0];
  }
  const type = Array.isArray(schema.type) ? schema.type.find((candidate) => candidate !== "null") ?? schema.type[0] : schema.type;
  switch (type) {
    case "null":
      return null;
    case "boolean":
      return false;
    case "integer":
      return numberFromSchema(schema, true);
    case "number":
      return numberFromSchema(schema, false);
    case "array": {
      if (schema.prefixItems?.length) {
        return schema.prefixItems.map((item) => jsonSchemaExample(item, depth + 1));
      }
      const length = schema.maxItems === 0 ? 0 : Math.max(1, schema.minItems ?? 0);
      return Array.from({ length }, () => jsonSchemaExample(schema.items ?? {}, depth + 1));
    }
    case "object": {
      const output = {};
      for (const key of schema.required ?? []) {
        output[key] = jsonSchemaExample(schema.properties?.[key] ?? {}, depth + 1);
      }
      return output;
    }
    case "string":
    default: {
      let value = (schema.pattern ? stringForPattern(schema.pattern) : null) ?? stringForFormat(schema.format);
      const minimum = schema.minLength ?? 0;
      if (value.length < minimum) value += "a".repeat(minimum - value.length);
      if (schema.maxLength !== void 0 && value.length > schema.maxLength) {
        value = value.slice(0, schema.maxLength);
      }
      return value;
    }
  }
}
function formatIssues(issues) {
  return issues.map(
    (issue) => issue && typeof issue === "object" && "message" in issue ? String(issue.message) : JSON.stringify(issue)
  ).join("; ");
}
function schemaMock(schema) {
  try {
    const first = JSON.parse(zodSchemaToJsonExample(schema));
    const firstResult = schema.safeParse(first);
    if (firstResult.success) return firstResult.data;
  } catch {
  }
  const jsonSchema = toJSONSchema(schema);
  const candidate = jsonSchemaExample(jsonSchema);
  const result = schema.safeParse(candidate);
  if (result.success) return result.data;
  throw new TypeError(`Could not generate a valid schema-aware mock: ${formatIssues(result.error.issues)}`);
}

// src/fakeAgent.ts
var autoMarker = /* @__PURE__ */ Symbol.for("smithers.testing.auto");
var auto = Object.freeze({
  [autoMarker]: true
});
function isAuto(value) {
  return Boolean(
    value && typeof value === "object" && value[autoMarker] === true
  );
}
function schemaExample(schema) {
  return schemaMock(schema);
}
function formatIssues2(issues) {
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
  throw new TypeError(`Fake agent output failed validation: ${formatIssues2(result.error.issues)}`);
}
function hasResponseKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "output" in value || "text" in value || "files" in value;
}
function normalizeResult(schema, result) {
  if (isAuto(result)) {
    return { output: schemaExample(schema) };
  }
  if (hasResponseKeys(result) && !("output" in result)) {
    const response = {};
    if (typeof result.text === "string") response.text = result.text;
    if (result.files) response.files = result.files;
    return response;
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
function formatIssues3(issues) {
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
  return schemaMock(task.outputSchema);
}
function validateTaskOutput(task, value) {
  if (!task.outputSchema) return value;
  const parsed = task.outputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw simulatorError(
    `simulate(): task "${task.nodeId}" output failed validation: ${formatIssues3(parsed.error.issues)}`,
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
  if (task.label && Object.prototype.hasOwnProperty.call(mocks, task.label)) {
    return { matched: true, key: task.label, value: mocks[task.label] };
  }
  for (const key of Object.keys(mocks)) {
    if (key === "*" || !key.includes("*")) continue;
    if (globMatches(key, task.nodeId) || task.label !== void 0 && globMatches(key, task.label)) {
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
function normalizeFunctionMockResult(task, result) {
  if (!task.outputSchema || !isObject(result) || !("output" in result)) {
    return result;
  }
  const parsedOutput = task.outputSchema.safeParse(result.output);
  return parsedOutput.success ? parsedOutput.data : result;
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
    return normalizeFunctionMockResult(task, result);
  }
  return mock;
}
function simulate(workflow, options = {}) {
  return __simulateWithControls(workflow, options);
}
function __simulateWithControls(workflow, options = {}, controls) {
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
      const controlledGraph = controls?.transformGraph?.(graph) ?? graph;
      latestTasks.clear();
      for (const task of controlledGraph.tasks) {
        latestTasks.set(task.nodeId, task);
      }
      latestAgentTaskIds = controlledGraph.tasks.filter(isAgentTask).map((task) => task.nodeId);
      controls?.onGraph?.(controlledGraph);
      return controlledGraph;
    }
  };
  const executeTask = async (task, context) => {
    const record = getTaskRecord(taskRecords, task.nodeId);
    handle.executed.push(task.nodeId);
    controls?.onTaskStarted?.(task);
    record.prompts.push(task.prompt);
    const agentTask = isAgentTask(task);
    try {
      const mock = resolveMock(mocks, task, agentTask);
      let value;
      if (mock.matched) {
        consumedMocks.add(mock.key);
        updateUnusedMocks(handle, mocks, consumedMocks);
        value = await materializeMock(mock.value, task, context, options.rootDir, runId);
      } else if (controls?.executeUnmocked) {
        const controlled = await controls.executeUnmocked(task, context);
        if (controlled.handled) {
          value = controlled.value;
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
      controls?.onTaskValidated?.(task, parsed);
      const channel = task.outputTableName;
      (handle.outputs[channel] ??= []).push(parsed);
      record.outputs.push(parsed);
      record.status = "finished";
      handle.output = parsed;
      return parsed;
    } catch (error) {
      record.status = "failed";
      lastExecutionError = error;
      controls?.onTaskError?.(task, error);
      throw error;
    }
  };
  async function runSimulation() {
    handle.status = "running";
    try {
      let session;
      const driver = new WorkflowDriver({
        workflow,
        runtime: {
          runPromise: (effect) => Effect.runPromise(effect)
        },
        renderer,
        createSession: (sessionOptions) => {
          session = makeWorkflowSession({
            runId: sessionOptions.runId,
            ...controls?.nowMs ? { nowMs: controls.nowMs } : {},
            requireStableFinish: true,
            requireRerenderOnOutputChange: sessionOptions.options?.requireRerenderOnOutputChange !== false
          });
          return session;
        },
        executeTask,
        ...controls?.resolveWait ? {
          onWait: (reason) => {
            if (!session) throw new Error("simulate(): workflow session was not initialized");
            return controls.resolveWait(reason, session);
          }
        } : {},
        ...controls?.continueAsNew ? {
          continueAsNew: (transition) => controls.continueAsNew(transition)
        } : {}
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
        handle.warnings.push(`simulate(): run finished with ${result.failedChildren} failed child task(s).`);
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

// src/coverWorkflow.ts
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join as join2 } from "path";
import { Effect as Effect2 } from "effect";
var WorkflowCoverageError = class extends Error {
  result;
  constructor(message, result) {
    super(message);
    this.name = "WorkflowCoverageError";
    this.result = result;
  }
};
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function workflowFromModule(candidate) {
  const workflow = isRecord(candidate) && "default" in candidate ? candidate.default : candidate;
  if (!workflow || typeof workflow !== "object" || typeof workflow.build !== "function") {
    throw new TypeError("coverWorkflow(): expected a workflow definition or a module with a default workflow export");
  }
  return workflow;
}
function schemaExample3(task) {
  if (!task.outputSchema) return null;
  return schemaMock(task.outputSchema);
}
function stateKey(task) {
  return `${task.nodeId}::${task.iteration}`;
}
function cloneWithLoopCap(node, maxLoopIterations) {
  if (!node || node.kind === "text") return node;
  const children = node.children.map((child) => cloneWithLoopCap(child, maxLoopIterations));
  if (node.tag !== "smithers:ralph") return { ...node, children };
  const { continueAsNewEvery: _continueAsNewEvery, ...props } = node.props;
  const declared = Number(props.maxIterations);
  const bound = Number.isInteger(declared) && declared > 0 ? Math.min(declared, maxLoopIterations) : maxLoopIterations;
  return {
    ...node,
    props: {
      ...props,
      maxIterations: String(bound),
      onMaxReached: "return-last"
    },
    children
  };
}
function capLoops(graph, maxLoopIterations) {
  return {
    ...graph,
    xml: cloneWithLoopCap(graph.xml, maxLoopIterations)
  };
}
function globMatches2(pattern, value) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
function isAllowed(nodeId, allowlist) {
  return allowlist.some((entry) => globMatches2(entry, nodeId));
}
function errorCode(error) {
  return isRecord(error) && typeof error.code === "string" ? error.code : void 0;
}
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function failure(passIndex, cause, nodeId) {
  return {
    passIndex,
    ...nodeId ? { nodeId } : {},
    ...errorCode(cause) ? { code: errorCode(cause) } : {},
    message: errorMessage(cause),
    cause
  };
}
function invalidOutputError(task, message) {
  return Object.assign(new Error(`coverWorkflow(): task "${task.nodeId}" output failed validation: ${message}`), {
    name: "SimulationError",
    code: "INVALID_OUTPUT",
    details: { failureRetryable: false }
  });
}
function validateExternalOutput(task, value, passIndex, validations) {
  if (!task.outputSchema) return value;
  const parsed = task.outputSchema.safeParse(value);
  if (parsed.success) {
    validations.push({
      passIndex,
      nodeId: task.nodeId,
      iteration: task.iteration,
      valid: true
    });
    return parsed.data;
  }
  const message = parsed.error.issues.map((issue) => issue.message).join("; ");
  validations.push({
    passIndex,
    nodeId: task.nodeId,
    iteration: task.iteration,
    valid: false,
    message
  });
  throw invalidOutputError(task, message);
}
function normalizeApproval(value) {
  if (value === true || value === "approve") return { approved: true };
  if (value === false || value === "deny") return { approved: false };
  return value;
}
function looksLikeApprovalValue(value) {
  return isRecord(value) && typeof value.approved === "boolean";
}
function taskContext(task, input, passIndex) {
  return {
    nodeId: task.nodeId,
    ...task.label ? { label: task.label } : {},
    iteration: task.iteration,
    input,
    passIndex
  };
}
function lookupByTask(values, task, extraKey) {
  if (Object.prototype.hasOwnProperty.call(values, task.nodeId)) return values[task.nodeId];
  if (task.label && Object.prototype.hasOwnProperty.call(values, task.label)) return values[task.label];
  if (extraKey && Object.prototype.hasOwnProperty.call(values, extraKey)) return values[extraKey];
  return values["*"];
}
async function approvalFor(options, task, input, passIndex) {
  const configured = options.approvals;
  let value;
  if (configured === void 0 || typeof configured === "boolean" || typeof configured === "string" || typeof configured === "function" || looksLikeApprovalValue(configured)) {
    value = configured;
  } else {
    value = lookupByTask(configured, task);
  }
  const resolved = typeof value === "function" ? await value(taskContext(task, input, passIndex)) : value;
  return normalizeApproval(resolved ?? true);
}
function approvalTaskOutput(task, decision) {
  if (decision.output !== void 0) return decision.output;
  const generated = schemaExample3(task);
  if (!isRecord(generated)) return generated;
  const output = { ...generated };
  if ("approved" in output) output.approved = decision.approved;
  if (decision.note !== void 0 && "note" in output) output.note = decision.note;
  if (decision.decidedBy !== void 0) {
    if ("decidedBy" in output) output.decidedBy = decision.decidedBy;
    if ("reviewer" in output) output.reviewer = decision.decidedBy;
  }
  if (task.approvalMode === "select" && "selected" in output) {
    output.selected = decision.optionKey ?? task.approvalOptions?.[0]?.key ?? "";
  }
  if (task.approvalMode === "rank" && "ranked" in output) {
    output.ranked = task.approvalOptions?.map((option) => option.key) ?? [];
  }
  return output;
}
async function eventPayloadFor(options, task, eventName, input, passIndex) {
  const eventValue = options.events ? lookupByTask(options.events, task, eventName) : void 0;
  const signalValue = options.signals ? lookupByTask(options.signals, task, eventName) : void 0;
  const configured = eventValue ?? signalValue;
  if (typeof configured !== "function") return configured === void 0 ? schemaExample3(task) : configured;
  const correlationId = typeof task.meta?.__correlationId === "string" ? task.meta.__correlationId : void 0;
  return configured({
    ...taskContext(task, input, passIndex),
    eventName,
    ...correlationId ? { correlationId } : {}
  });
}
function isIsolatedSideEffect(task) {
  return Boolean(task.sideEffect || task.meta?.__sandbox || task.meta?.__subflow);
}
async function runEffect(effect) {
  return Effect2.runPromise(effect);
}
async function decideAgain(session) {
  const graph = await runEffect(session.getCurrentGraph());
  if (!graph) throw new Error("coverWorkflow(): workflow session has no current graph");
  return runEffect(session.submitGraph(graph));
}
function waitingTask(state, states, expectedState, predicate) {
  return [...state.descriptors.values()].reverse().find((task) => states.get(stateKey(task)) === expectedState && (!predicate || predicate(task)));
}
function timerDeadline(state, task) {
  const key = stateKey(task);
  const existing = state.timerDeadlines.get(key);
  if (existing !== void 0) return existing;
  const until = task.meta?.__timerUntil;
  let deadline;
  if (typeof until === "string" && until.length > 0) {
    const parsed = Date.parse(until);
    if (Number.isFinite(parsed)) deadline = Math.floor(parsed);
  } else {
    const duration = task.meta?.__timerDuration;
    if (typeof duration === "string") {
      const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(duration.trim().toLowerCase());
      const multipliers = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
      const multiplier = match ? multipliers[match[2] ?? "ms"] : void 0;
      const amount = match ? Number(match[1]) : Number.NaN;
      if (multiplier !== void 0 && Number.isFinite(amount)) {
        deadline = state.nowMs + Math.floor(amount * multiplier);
      }
    }
  }
  if (deadline !== void 0) state.timerDeadlines.set(key, deadline);
  return deadline;
}
function appendOutput(record, key, value) {
  (record[key] ??= []).push(value);
}
function mergeOutputs(target, source) {
  for (const [key, values] of Object.entries(source)) {
    (target[key] ??= []).push(...values);
  }
}
async function runCoveragePass(workflow, options, input, passIndex, rootDir, maxLoopIterations) {
  const state = {
    defined: /* @__PURE__ */ new Set(),
    descriptors: /* @__PURE__ */ new Map(),
    executionOrder: [],
    suppressTaskStart: /* @__PURE__ */ new Set(),
    externalTaskOutputs: {},
    externalTableOutputs: {},
    validations: [],
    approvals: [],
    taskFailures: [],
    approvalOutputs: /* @__PURE__ */ new Map(),
    timerDeadlines: /* @__PURE__ */ new Map(),
    nowMs: Date.now()
  };
  const callerMocks = options.mocks ?? {};
  const injectedCatchAll = !Object.prototype.hasOwnProperty.call(callerMocks, "*");
  const mocks = { "*": auto, ...callerMocks };
  const sim = __simulateWithControls(
    workflow,
    {
      input,
      mocks,
      rootDir,
      workflowPath: options.workflowPath
    },
    {
      nowMs: () => state.nowMs,
      transformGraph: (graph) => capLoops(graph, maxLoopIterations),
      onGraph: (graph) => {
        state.latestGraph = graph;
        for (const task of graph.tasks) {
          state.defined.add(task.nodeId);
          state.descriptors.set(stateKey(task), task);
        }
      },
      onTaskStarted: (task) => {
        const key = stateKey(task);
        if (state.suppressTaskStart.delete(key)) return;
        state.executionOrder.push(task.nodeId);
      },
      onTaskValidated: (task) => {
        if (!task.outputSchema) return;
        state.validations.push({
          passIndex,
          nodeId: task.nodeId,
          iteration: task.iteration,
          valid: true
        });
      },
      onTaskError: (task, error) => {
        state.taskFailures.push(failure(passIndex, error, task.nodeId));
        if (task.outputSchema && (errorCode(error) === "INVALID_OUTPUT" || /validation/i.test(errorMessage(error)))) {
          state.validations.push({
            passIndex,
            nodeId: task.nodeId,
            iteration: task.iteration,
            valid: false,
            message: errorMessage(error)
          });
        }
      },
      executeUnmocked: async (task) => {
        if (task.kind === "human") {
          return {
            handled: true,
            value: state.approvalOutputs.get(stateKey(task)) ?? schemaExample3(task)
          };
        }
        if (task.needsApproval && (task.meta?.requestTitle || task.approvalMode !== "gate")) {
          return {
            handled: true,
            value: state.approvalOutputs.get(stateKey(task)) ?? schemaExample3(task)
          };
        }
        if (isIsolatedSideEffect(task)) {
          return options.executeSideEffects ? { handled: false } : { handled: true, value: schemaExample3(task) };
        }
        if (!options.executeCompute && task.computeFn) {
          return { handled: true, value: schemaExample3(task) };
        }
        return { handled: false };
      },
      resolveWait: async (reason, session) => {
        if (reason._tag === "Approval") {
          const states = await runEffect(session.getTaskStates());
          const task = waitingTask(state, states, "waiting-approval", (candidate) => candidate.nodeId === reason.nodeId) ?? [...state.descriptors.values()].reverse().find((candidate) => candidate.nodeId === reason.nodeId);
          if (!task) throw new Error(`coverWorkflow(): approval task "${reason.nodeId}" was not rendered`);
          const decision = await approvalFor(options, task, input, passIndex);
          const output = approvalTaskOutput(task, decision);
          state.approvalOutputs.set(stateKey(task), output);
          state.approvals.push({
            passIndex,
            nodeId: task.nodeId,
            iteration: task.iteration,
            approved: decision.approved,
            ...decision.note ? { note: decision.note } : {},
            ...decision.decidedBy ? { decidedBy: decision.decidedBy } : {}
          });
          state.executionOrder.push(task.nodeId);
          state.suppressTaskStart.add(stateKey(task));
          return runEffect(
            session.approvalResolved(task.nodeId, {
              approved: decision.approved,
              ...decision.note !== void 0 ? { note: decision.note } : {},
              ...decision.decidedBy !== void 0 ? { decidedBy: decision.decidedBy } : {},
              ...decision.optionKey !== void 0 ? { optionKey: decision.optionKey } : {},
              ...decision.output !== void 0 ? { payload: decision.output } : {}
            })
          );
        }
        if (reason._tag === "Event") {
          const states = await runEffect(session.getTaskStates());
          const task = waitingTask(
            state,
            states,
            "waiting-event",
            (candidate) => candidate.meta?.__eventName === reason.eventName
          );
          if (!task) throw new Error(`coverWorkflow(): waiting event "${reason.eventName}" has no rendered task`);
          const rawPayload = await eventPayloadFor(options, task, reason.eventName, input, passIndex);
          const payload = validateExternalOutput(task, rawPayload, passIndex, state.validations);
          state.executionOrder.push(task.nodeId);
          appendOutput(state.externalTaskOutputs, task.nodeId, payload);
          if (task.outputTableName) appendOutput(state.externalTableOutputs, task.outputTableName, payload);
          const correlationId = typeof task.meta?.__correlationId === "string" ? task.meta.__correlationId : null;
          return runEffect(session.eventReceived(reason.eventName, payload, correlationId));
        }
        if (reason._tag === "Timer") {
          const states = await runEffect(session.getTaskStates());
          const waiting = [...state.descriptors.values()].reverse().filter((candidate) => states.get(stateKey(candidate)) === "waiting-timer");
          const deadlines = waiting.map((candidate) => ({ candidate, deadline: timerDeadline(state, candidate) }));
          const task = deadlines.find(({ deadline }) => deadline === reason.resumeAtMs)?.candidate ?? deadlines.filter((entry) => entry.deadline !== void 0).sort((left, right) => left.deadline - right.deadline)[0]?.candidate ?? (waiting.length === 1 ? waiting[0] : void 0);
          if (!task) throw new Error("coverWorkflow(): waiting timer has no rendered task");
          state.nowMs = Math.max(state.nowMs, reason.resumeAtMs);
          state.executionOrder.push(task.nodeId);
          appendOutput(state.externalTaskOutputs, task.nodeId, { firedAtMs: state.nowMs });
          return runEffect(session.timerFired(task.nodeId, state.nowMs));
        }
        if (reason._tag === "RetryBackoff") {
          state.nowMs += Math.max(0, reason.waitMs);
          return decideAgain(session);
        }
        if (reason._tag === "HotReload" && state.latestGraph) {
          return runEffect(session.hotReloaded(state.latestGraph));
        }
        if (reason._tag === "OrphanRecovery") {
          return runEffect(session.recoverOrphanedTasks());
        }
        return {
          runId: "coverage",
          status: reason._tag === "Quota" ? "waiting-quota" : "waiting-event",
          error: new Error(`coverWorkflow(): cannot auto-resolve ${reason._tag} wait`)
        };
      }
    }
  );
  let runError;
  try {
    await sim.run();
  } catch (error) {
    runError = error;
  }
  const taskOutputs = {};
  for (const nodeId of new Set(sim.executed)) {
    taskOutputs[nodeId] = sim.task(nodeId).outputs;
  }
  mergeOutputs(taskOutputs, state.externalTaskOutputs);
  const outputs = {};
  mergeOutputs(outputs, sim.outputs);
  mergeOutputs(outputs, state.externalTableOutputs);
  const finalTaskFailures = state.taskFailures.filter(
    (item) => item.nodeId !== void 0 && sim.task(item.nodeId).status === "failed"
  );
  const errors = finalTaskFailures.length > 0 ? finalTaskFailures : runError !== void 0 ? [failure(passIndex, runError)] : [];
  const executedSet = new Set(state.executionOrder);
  const definedNodes = [...state.defined];
  return {
    passIndex,
    input,
    status: sim.status,
    executed: state.executionOrder,
    outputs,
    taskOutputs,
    finalOutput: sim.output,
    definedNodes,
    unexecuted: definedNodes.filter((nodeId) => !executedSet.has(nodeId)),
    validations: state.validations,
    approvals: state.approvals,
    errors,
    // `unusedMocks` reports the CALLER's dead mocks. coverWorkflow injects its
    // own "*": auto catch-all, and a fully mocked run never consumes it, so
    // reporting it would make the list permanently non-empty and useless.
    unusedMocks: injectedCatchAll ? sim.unusedMocks.filter((key) => key !== "*") : sim.unusedMocks,
    warnings: sim.warnings
  };
}
function normalizeInputs(options) {
  if (options.input !== void 0 && options.inputs !== void 0) {
    throw new TypeError("coverWorkflow(): use either input or inputs, not both");
  }
  if (options.inputs !== void 0) {
    if (options.inputs.length === 0) throw new TypeError("coverWorkflow(): inputs must contain at least one value");
    return options.inputs;
  }
  return [options.input ?? {}];
}
function normalizeLoopCap(value) {
  const cap = value ?? 3;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new TypeError("coverWorkflow(): maxLoopIterations must be a positive integer");
  }
  return cap;
}
async function coverWorkflow(workflowModule, options = {}) {
  const workflow = workflowFromModule(workflowModule);
  const inputs = normalizeInputs(options);
  const maxLoopIterations = normalizeLoopCap(options.maxLoopIterations);
  const temporaryRoot = options.rootDir ? void 0 : await mkdtemp(join2(tmpdir(), "smithers-coverage-"));
  const rootDir = options.rootDir ?? temporaryRoot;
  const passes = [];
  try {
    for (let passIndex = 0; passIndex < inputs.length; passIndex += 1) {
      passes.push(await runCoveragePass(workflow, options, inputs[passIndex], passIndex, rootDir, maxLoopIterations));
    }
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
  const outputs = {};
  const taskOutputs = {};
  for (const pass of passes) {
    mergeOutputs(outputs, pass.outputs);
    mergeOutputs(taskOutputs, pass.taskOutputs);
  }
  const executed = passes.flatMap((pass) => pass.executed);
  const definedNodes = [...new Set(passes.flatMap((pass) => pass.definedNodes))];
  const coveredNodes = [...new Set(executed)];
  const coveredSet = new Set(coveredNodes);
  const definedSet = new Set(definedNodes);
  const allowUnreached = [...options.allowUnreached ?? []];
  const expectedNodes = [.../* @__PURE__ */ new Set([...options.expectedNodes ?? [], ...allowUnreached])];
  const result = {
    status: passes.every((pass) => pass.status === "finished") ? "finished" : "failed",
    passes,
    executed,
    outputs,
    taskOutputs,
    finalOutputs: passes.map((pass) => pass.finalOutput),
    definedNodes,
    coveredNodes,
    unexecuted: definedNodes.filter((nodeId) => !coveredSet.has(nodeId)),
    unreached: expectedNodes.filter((nodeId) => !definedSet.has(nodeId)),
    validations: passes.flatMap((pass) => pass.validations),
    approvals: passes.flatMap((pass) => pass.approvals),
    errors: passes.flatMap((pass) => pass.errors),
    allowUnreached
  };
  if (options.assert !== false) expectFullCoverage(result);
  return result;
}
function expectFullCoverage(result) {
  const failures = [];
  const unfinished = result.passes.filter((pass) => pass.status !== "finished");
  if (unfinished.length > 0) {
    failures.push(
      `unfinished passes: ${unfinished.map((pass) => `${pass.passIndex} (${JSON.stringify(pass.status)})`).join(", ")}`
    );
  }
  const unexpectedUnexecuted = result.unexecuted.filter((nodeId) => !isAllowed(nodeId, result.allowUnreached));
  if (unexpectedUnexecuted.length > 0) {
    failures.push(`unexecuted nodes: ${JSON.stringify(unexpectedUnexecuted)}`);
  }
  const unexpectedUnreached = result.unreached.filter((nodeId) => !isAllowed(nodeId, result.allowUnreached));
  if (unexpectedUnreached.length > 0) {
    failures.push(`unreached expected nodes: ${JSON.stringify(unexpectedUnreached)}`);
  }
  const invalid = result.validations.filter((validation) => !validation.valid);
  if (invalid.length > 0) {
    failures.push(
      `invalid structured outputs: ${invalid.map((item) => `${item.nodeId} (${item.message ?? "invalid"})`).join(", ")}`
    );
  }
  if (result.errors.length > 0) {
    failures.push(
      `errors: ${result.errors.map((item) => `${item.nodeId ? `${item.nodeId}: ` : ""}${item.message}`).join("; ")}`
    );
  }
  if (failures.length > 0) {
    throw new WorkflowCoverageError(`Workflow coverage failed:
- ${failures.join("\n- ")}`, result);
  }
  return result;
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
  if (!Number.isInteger(budget.steps) || budget.steps < 1 || budget.ms !== void 0 && (!Number.isFinite(budget.ms) || budget.ms < 0))
    throw new BoundedWaitError(budget);
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
var simulationClasses = /* @__PURE__ */ new Map();
var simulationClass = (className) => {
  let ctor = simulationClasses.get(className);
  if (!ctor) {
    ctor = class extends Error {
    };
    Object.defineProperty(ctor, "name", { value: className });
    Object.defineProperty(ctor.prototype, "name", {
      value: className,
      writable: true,
      enumerable: false,
      configurable: true
    });
    simulationClasses.set(className, ctor);
  }
  return ctor;
};
var simulationNativeError = (spec) => {
  const error = new (simulationClass(spec.className))(spec.message);
  if (spec.name !== void 0) error.name = spec.name;
  if (spec.code !== void 0) error.code = spec.code;
  if (spec.summary !== void 0) error.summary = spec.summary;
  if (spec.details !== void 0) error.details = spec.details;
  if (spec.docsUrl !== void 0) error.docsUrl = spec.docsUrl;
  if (spec.cause !== void 0) error.cause = spec.cause;
  for (const [key, value] of Object.entries(spec.extra ?? {})) error[key] = value;
  Object.defineProperty(error, "fidelity", { value: "simulation", enumerable: false });
  return error;
};
var simulationSmithersError = (code, summary, options = {}) => {
  const docsUrl = options.docsUrl ?? "https://smithers.sh/reference/errors";
  return simulationNativeError({
    className: "SmithersError",
    name: options.name ?? "SmithersError",
    message: summary.includes(docsUrl) ? summary : `${summary} See ${docsUrl}`,
    code,
    summary,
    docsUrl,
    ...options.details === void 0 ? {} : { details: options.details },
    ...options.cause === void 0 ? {} : { cause: options.cause }
  });
};
var durableJsonSafe = (value, seen) => {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(value) ? value : null;
  if (type === "bigint") return value.toString();
  if (type === "undefined" || type === "function" || type === "symbol") return void 0;
  const record = value;
  if (seen.has(record)) return "[Circular]";
  seen.add(record);
  try {
    if (record instanceof Error) {
      const out2 = { name: record.name, message: record.message, stack: record.stack };
      if (record.cause !== void 0) out2.cause = durableJsonSafe(record.cause, seen);
      for (const key of Object.keys(record)) {
        if (key in out2) continue;
        const safe = durableJsonSafe(record[key], seen);
        if (safe !== void 0) out2[key] = safe;
      }
      return out2;
    }
    if (Array.isArray(record))
      return record.map((item) => {
        const safe = durableJsonSafe(item, seen);
        return safe === void 0 ? null : safe;
      });
    const out = {};
    for (const [key, entry] of Object.entries(record)) {
      const safe = durableJsonSafe(entry, seen);
      if (safe !== void 0) out[key] = safe;
    }
    return out;
  } finally {
    seen.delete(record);
  }
};
var serializeSimulationDurableError = (value) => {
  if (value instanceof Error && value.constructor?.name === "SmithersError") {
    const error = value;
    return durableJsonSafe(
      {
        name: error.name,
        code: error.code,
        message: error.message,
        stack: error.stack,
        cause: error.cause,
        summary: error.summary,
        docsUrl: error.docsUrl,
        details: error.details
      },
      /* @__PURE__ */ new WeakSet()
    );
  }
  return durableJsonSafe(value, /* @__PURE__ */ new WeakSet());
};
var BOUNDARY_KNOWN_FIELDS = /* @__PURE__ */ new Set([
  "name",
  "message",
  "code",
  "summary",
  "details",
  "docsUrl",
  "cause",
  "stack",
  "fidelity",
  "serialized"
]);
var serializeBoundaryError = (value) => {
  if (!(value instanceof Error)) return value;
  const error = value;
  const native = {};
  for (const key of Object.keys(error).sort()) {
    const field = error[key];
    if (BOUNDARY_KNOWN_FIELDS.has(key) || typeof field === "function" || field === void 0) continue;
    native[key] = field;
  }
  return {
    name: error.name,
    message: error.message,
    ...error.code === void 0 ? {} : { code: error.code },
    ...error.summary === void 0 ? {} : { summary: error.summary },
    ...error.details === void 0 ? {} : { details: JSON.parse(JSON.stringify(error.details ?? null)) },
    ...error.docsUrl === void 0 ? {} : { docsUrl: error.docsUrl },
    ...Object.keys(native).length === 0 ? {} : { native: JSON.parse(JSON.stringify(native)) },
    ...error.cause === void 0 ? {} : { cause: serializeBoundaryError(error.cause) }
  };
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
var makeReplayBundle = (input) => Object.freeze({
  version: 1,
  ast: JSON.parse(canonicalize(input.ast)),
  seed: input.seed,
  controlLog: JSON.parse(JSON.stringify(input.controlLog)),
  trace: JSON.parse(JSON.stringify(input.trace ?? [])),
  ambiguity: JSON.parse(JSON.stringify(input.ambiguity ?? [])),
  determinism: input.determinism ?? { deterministic: true, residues: [] },
  harness: input.harness ?? "unit-sim",
  harnessIdentity: input.harnessIdentity ?? input.harness ?? "unit-sim",
  runnerBindings: Object.fromEntries(
    input.ast.steps.filter((step2) => step2.runnerBinding).map((step2) => [step2.id, step2.runnerBinding])
  ),
  replayIdentity: replayIdentity(input)
});
var serializeReplayBundle = (bundle) => JSON.stringify(bundle);
var loadReplayBundle = (serialized) => {
  const value = JSON.parse(serialized);
  if (value.version !== 1 || !value.ast || !Array.isArray(value.controlLog) || typeof value.seed !== "number")
    throw new Error("INVALID_REPLAY_BUNDLE");
  const bundle = makeReplayBundle(value);
  if (bundle.replayIdentity !== value.replayIdentity) throw new Error("REPLAY_IDENTITY_MISMATCH");
  return Object.freeze({ ...bundle, runnerBindings: value.runnerBindings ?? {} });
};
var replayBundle = async (bundle, options = {}) => {
  const { runScenario: runScenario2 } = await Promise.resolve().then(() => (init_runScenario(), runScenario_exports));
  if (bundle.replayIdentity !== replayIdentity({ ast: bundle.ast, seed: bundle.seed, controlLog: bundle.controlLog }))
    throw new Error("REPLAY_IDENTITY_MISMATCH");
  const selectedHarness = options.harness?.name ?? "unit-sim";
  const selectedIdentity = options.harness?.adapter?.verifiedProductionIdentity ?? options.harness?.adapter?.identity ?? selectedHarness;
  if (selectedHarness !== bundle.harness || selectedIdentity !== bundle.harnessIdentity)
    throw new Error(
      `REPLAY_HARNESS_MISMATCH: bundle=${bundle.harness}/${bundle.harnessIdentity} selected=${selectedHarness}/${selectedIdentity}`
    );
  const runners2 = options.stepRunners ?? {};
  const unbound = Object.keys(runners2).filter(
    (id) => bundle.ast.steps.some((step2) => step2.id === id && !step2.runnerBinding)
  );
  if (unbound.length) throw new Error(`RUNNER_BINDING_REQUIRED: ${unbound.join(", ")}`);
  const bindings = /* @__PURE__ */ new Map();
  for (const step2 of bundle.ast.steps) {
    if (!step2.runnerBinding || !runners2[step2.id]) continue;
    const prior = bindings.get(step2.runnerBinding);
    if (prior && prior !== runners2[step2.id]) throw new Error(`REPLAY_RUNNER_BINDING_CONFLICT: ${step2.runnerBinding}`);
    bindings.set(step2.runnerBinding, runners2[step2.id]);
  }
  const missing = bundle.ast.steps.filter((step2) => step2.runnerBinding && !runners2[step2.id] && !stepRunner(step2)).map((step2) => step2.id);
  if (missing.length) throw new Error(`REPLAY_RUNNER_MISSING: ${missing.join(", ")}`);
  return runScenario2(bundle.ast, {
    ...options,
    ...Object.keys(runners2).length ? { stepRunners: runners2 } : {},
    seed: bundle.seed,
    controlLog: bundle.controlLog
  });
};

// src/dryRun.ts
var dryRun = (ast, options = {}) => {
  const seed = options.seed ?? ast.seed ?? 0;
  const controls = options.controlLog ?? [];
  const harness = options.harness;
  const compiled = compileScenario(ast, new Set(Object.keys(harness?.adapter?.extensionExecutors ?? {})));
  return {
    canonicalAst: canonicalize(ast),
    replayIdentity: replayIdentity({ ast, seed, controlLog: controls }),
    admissions: harness?.admitScenario(ast, options.capabilities ?? []) ?? [],
    diagnostics: compiled.ok ? [] : compiled.diagnostics,
    requiredCapabilities: compiled.requiredCapabilities,
    replayBundle: makeReplayBundle({ ast, seed, controlLog: controls, harness: harness?.name }),
    plannedSteps: ast.steps.map((step2) => step2.id),
    executesAgents: false,
    run: () => runScenario(ast, options)
  };
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
    return {
      requests: [...this.requests],
      outcomes: Object.fromEntries(this.outcomes),
      journal: Object.fromEntries(this.journal)
    };
  }
};
var mediatedEffect = async (ledger, request, execute) => {
  ledger.request(request);
  const outcome = ledger.get(request.id);
  if (outcome?.kind === "fail") throw outcome.value;
  if (outcome?.kind === "hang")
    throw Object.assign(new Error("effect resolution was not supplied within the run budget"), {
      code: "EFFECT_WAIT_BUDGET_EXHAUSTED"
    });
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
var publicErrorFields = (value) => Object.fromEntries(
  ["name", "message", "code", "tag", "summary", "details", "docsUrl", "cause"].filter((key) => value[key] !== void 0).map((key) => [key, value[key]])
);
var ownErrorField = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.get ? descriptor.get.call(value) : descriptor?.value;
};
var boundarySerializable = (value, seen = /* @__PURE__ */ new Set()) => {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const record = value;
  return publicErrorFields({
    name: ownErrorField(record, "name"),
    message: ownErrorField(record, "message"),
    code: ownErrorField(record, "code"),
    tag: ownErrorField(record, "tag"),
    summary: ownErrorField(record, "summary"),
    details: ownErrorField(record, "details"),
    docsUrl: ownErrorField(record, "docsUrl"),
    cause: ownErrorField(record, "cause") === void 0 ? void 0 : boundarySerializable(ownErrorField(record, "cause"), seen)
  });
};
var boundaryShape = (error, serialized) => {
  const value = error && typeof error === "object" ? error : {};
  const name = ownErrorField(value, "name") ?? value.name;
  const message = ownErrorField(value, "message") ?? value.message;
  const causeValue = ownErrorField(value, "cause") ?? value.cause;
  const details = ownErrorField(value, "details") ?? value.details;
  const cause = causeValue === void 0 ? void 0 : boundaryShape(causeValue);
  const nativeSerialized = serialized ?? (error instanceof Error ? boundarySerializable(error) : void 0);
  return {
    name: String(name ?? "Error"),
    className: error && typeof error === "object" ? String(error.constructor?.name ?? "Object") : "Error",
    ...value.tag === void 0 ? {} : { tag: String(value.tag) },
    ...value.code === void 0 ? {} : { code: String(value.code) },
    ...message === void 0 ? {} : { message: String(message) },
    ...value.summary === void 0 ? {} : { summary: String(value.summary) },
    hasCause: causeValue !== void 0,
    ...cause ? { cause } : {},
    ...details === void 0 ? {} : { details },
    detailsKeys: details && typeof details === "object" ? Object.keys(details).sort() : [],
    ...value.docsUrl === void 0 ? {} : { docsUrl: String(value.docsUrl) },
    ...nativeSerialized === void 0 ? {} : { serialized: nativeSerialized }
  };
};
var equal = (a, b) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || !a || !b || typeof a !== "object") return false;
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every(
    (key, index) => key === bk[index] && equal(a[key], b[key])
  );
};
var compareBoundaryShape = (expected, actual) => {
  const fields = [
    "name",
    "className",
    "tag",
    "code",
    "message",
    "summary",
    "hasCause",
    "details",
    "detailsKeys",
    "docsUrl",
    "serialized"
  ];
  const differences = fields.filter((field) => !equal(expected[field], actual[field])).map((field) => field + " differs");
  if (!equal(expected.cause, actual.cause)) differences.push("cause differs");
  return differences;
};

// src/probes/contractProbe.ts
var defaultSerialize = (value) => {
  if (!(value instanceof Error)) return value;
  const record = value;
  return JSON.parse(
    JSON.stringify({
      name: value.name,
      message: value.message,
      ...Object.fromEntries(
        Object.keys(record).sort().map((key) => [key, record[key]])
      )
    })
  );
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
var effectEvents = (result, name) => result.trace.filter(
  (event) => event.type === "effect" && event.data?.name === name
);
var assertion = (name, guarantee, check, message) => Object.freeze({
  name,
  guarantee,
  assert: (result) => {
    const events = effectEvents(result, name).filter(
      (event) => event.data?.state === "resolved"
    ).length;
    if (!check(events, result)) throw new Error(`${guarantee} assertion failed for ${name}: ${message}`);
  }
});
var journaled = (result, name) => result.trace.filter((event) => {
  const data = event.data;
  return event.type === "durability" && data?.operation === "journal-write" && (data.effect === name || String(data.effect ?? "").endsWith(`:${name}`));
}).length;
var acknowledgements = (result, name) => result.trace.filter((event) => {
  const data = event.data;
  return event.type === "durability" && data?.operation === "ack" && (data.effect === name || String(data.effect ?? "").endsWith(`:${name}`));
}).length;
var expectEffect = (name) => ({
  name,
  exactlyOnce: () => {
    throw new ExactlyOnceUnsupportedError();
  },
  atLeastOnce: (result) => {
    const value = assertion(
      name,
      "at-least-once",
      (events) => events >= 1,
      "no mediated effect resolution was observed"
    );
    if (result) value.assert(result);
    return value;
  },
  atMostOnceJournaled: (result) => {
    const value = assertion(
      name,
      "journaled-at-most-once",
      (_events, observed) => journaled(observed, name) <= 1,
      "more than one journal-write observation was recorded"
    );
    if (result) value.assert(result);
    return value;
  },
  idempotencyKey: (key, result) => {
    const value = Object.freeze({
      ...assertion(
        name,
        "idempotency-key",
        (events, observed) => events >= 1 && effectEvents(observed, name).some(
          (event) => event.data?.idempotencyKey === key
        ),
        key ? `idempotency key ${key} was not observed` : "an idempotency key was not observed"
      ),
      key
    });
    if (result) value.assert(result);
    return value;
  },
  journalCas: (result) => {
    const value = assertion(
      name,
      "journal-cas",
      (_events, observed) => journaled(observed, name) === 1 && acknowledgements(observed, name) === 1,
      "journal CAS did not produce exactly one scoped journal-write followed by its ack"
    );
    if (result) value.assert(result);
    return value;
  }
});
var expectTrace = (predicate, message = "trace predicate did not match") => (result) => {
  if (!result.trace.some(predicate)) throw new Error(`trace assertion failed: ${message}`);
};
var expectAmbiguity = (outcome) => (result) => {
  if (!result.ambiguity.some((item) => item.outcome === outcome))
    throw new Error(`ambiguity assertion failed: ${outcome}`);
};

// src/replay/firstDivergence.ts
var firstField = (left, right) => {
  if (Object.is(left, right)) return void 0;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return "value";
  const keys = [.../* @__PURE__ */ new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.find(
    (key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])
  );
};
var firstDivergence = (left, right) => {
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const field = firstField(left[i], right[i]);
    if (field !== void 0 || left[i] === void 0 !== (right[i] === void 0)) {
      const leftIndex = left[i]?.data?.controlIndex;
      const rightIndex = right[i]?.data?.controlIndex;
      const controlIndex = typeof leftIndex === "number" ? leftIndex : typeof rightIndex === "number" ? rightIndex : void 0;
      return {
        index: i,
        sequence: left[i]?.seq ?? right[i]?.seq ?? i,
        ...controlIndex === void 0 ? {} : { controlIndex },
        field,
        left: left[i],
        right: right[i],
        message: `trace divergence at event ${i}${controlIndex === void 0 ? "" : ` (control ${controlIndex})`}${field ? ` (${field})` : ""}`
      };
    }
  }
  return null;
};

// src/replay/shrink.ts
init_compile();
init_runScenario();
var controlsValid = (ast, controls) => {
  const steps = new Set(ast.steps.map((step2) => step2.id));
  const faults = new Set(ast.faults.map((fault2) => fault2.id));
  const barriers = new Set(ast.barriers.map((barrier2) => barrier2.id));
  return controls.every(
    (control) => (control.type !== "pin-interleaving" || steps.has(control.choice)) && (control.type !== "task-restart" || steps.has(control.step)) && (control.type !== "inject-fault" || faults.has(control.fault)) && (control.type !== "release-barrier" || barriers.has(control.barrier)) && (control.type !== "resolve-effect" || steps.has(control.effect.split(":", 1)[0]))
  );
};
var removeStep = (ast, id) => {
  const referenced = new Set(ast.steps.flatMap((step2) => step2.dependsOn));
  if (referenced.has(id) || ast.barriers.some((barrier2) => barrier2.parties.includes(id))) return ast;
  const removed = ast.steps.find((step2) => step2.id === id);
  if (removed?.capabilities.some(
    (capability) => ast.steps.filter((step2) => step2.id !== id).every((step2) => !step2.capabilities.includes(capability))
  ))
    return ast;
  return { ...ast, steps: ast.steps.filter((step2) => step2.id !== id) };
};
var shrink = async (ast, controls, failure2, options = {}) => {
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
      if (candidate === current) continue;
      const candidateControls = currentControls.filter(
        (control) => (control.type !== "pin-interleaving" || control.choice !== step2.id) && (control.type !== "task-restart" || control.step !== step2.id) && (control.type !== "resolve-effect" || control.effect.split(":", 1)[0] !== step2.id)
      );
      if (!compileScenario(candidate).ok || !controlsValid(candidate, candidateControls)) continue;
      tried++;
      const result = await runScenario(candidate, {
        ...options,
        controlLog: candidateControls,
        seed: options.seed ?? candidate.seed
      });
      if (await failure2(candidate, candidateControls, result)) {
        current = candidate;
        currentControls = candidateControls;
        changed = true;
        break;
      }
    }
  }
  for (let i = 0; i < currentControls.length && tried < max; i++) {
    const candidateControls = currentControls.filter((_, index) => index !== i);
    if (candidateControls.length === currentControls.length || !controlsValid(current, candidateControls)) continue;
    tried++;
    const result = await runScenario(current, {
      ...options,
      controlLog: candidateControls,
      seed: options.seed ?? current.seed
    });
    if (await failure2(current, candidateControls, result)) {
      currentControls = candidateControls;
      i = -1;
    }
  }
  return { ast: current, controls: currentControls, candidatesTried: tried };
};

// src/adapters/realDbAdapter.ts
init_Harness();
import { SmithersDb } from "@smithers-orchestrator/db/adapter";

// src/adapters/realDbCutPoints.ts
var preserve = (value) => value;
var invoke = (receiver, method, args) => typeof method === "function" ? method.apply(receiver, [...args]) : void 0;
var realDbCutPoints = (db) => Object.freeze({
  claimAttemptCompletion: (input) => preserve(
    invoke(db, db.claimAttemptCompletion, [
      input.runId,
      input.nodeId,
      input.iteration,
      input.attempt,
      input.runtimeOwnerId,
      input.finishedAtMs
    ])
  ),
  claimRunForResume: (input) => preserve(invoke(db, db.claimRunForResume, [input])),
  heartbeatRun: (input) => preserve(
    invoke(db, db.heartbeatRun, [
      input.runId,
      input.runtimeOwnerId,
      input.heartbeatAtMs
    ])
  ),
  completeRun: (input) => preserve(
    invoke(db, db.completeRun, [
      input.runId,
      input.runtimeOwnerId,
      input.finishedAtMs
    ])
  ),
  requestRunCancel: (input) => preserve(
    invoke(db, db.requestRunCancel, [input.runId, input.cancelRequestedAtMs])
  ),
  claimRunCancellation: (input) => preserve(
    invoke(db, db.claimRunCancellation, [
      input.runId,
      input.cancelledAtMs,
      input.errorJson
    ])
  )
});

// src/adapters/realDbAdapter.ts
import { existsSync } from "fs";
var realDbAdapter = (options) => {
  const productionOperations = /* @__PURE__ */ new Set([
    "claimAttemptCompletion",
    "claimRunForResume",
    "heartbeatRun",
    "completeRun",
    "requestRunCancel",
    "claimRunCancellation",
    "heartbeatAttempt"
  ]);
  let resource;
  const runDb = async (value) => {
    if (value && typeof value.then === "function") return await value;
    return value;
  };
  const executableCutPoints = /* @__PURE__ */ new Set([
    "completion-cas:before-task",
    "completion-cas:after-task",
    "completion-cas:after-journal-before-ack",
    "resume:before-task",
    "heartbeat:during-task",
    "cancellation:during-task"
  ]);
  return registerTrustedAdapter(
    {
      identity: options.identity ?? "real-db:sqlite",
      verifiedProductionIdentity: "@smithers-orchestrator/db/adapter:SmithersDb",
      supportedCutPoints: executableCutPoints,
      admissionProbe: async () => {
        resource = await options.open();
        if (!(resource instanceof SmithersDb) || !resource.db || typeof resource.insertRun !== "function" || typeof resource.heartbeatRun !== "function" || typeof resource.close !== "function") {
          throw Object.assign(
            new Error(
              "real-db adapter requires a live SmithersDb backed by Bun SQLite; declarations and echo objects are not proof"
            ),
            { code: "ADMISSION_FAILED" }
          );
        }
        if (!resource.path || resource.path === ":memory:" || resource.path.startsWith("file::memory:")) {
          throw Object.assign(new Error("real-db admission requires an on-disk SQLite database"), {
            code: "ADMISSION_FAILED",
            details: { path: resource.path ?? null }
          });
        }
        if (!existsSync(resource.path))
          throw Object.assign(new Error("real-db admission could not verify the on-disk database"), {
            code: "ADMISSION_FAILED",
            details: { path: resource.path }
          });
        try {
          const sqlite = resource.db.$client ?? resource.db;
          sqlite.query("SELECT 1").get();
        } catch (cause) {
          throw Object.assign(new Error("real-db admission could not execute SQLite"), {
            code: "ADMISSION_FAILED",
            cause
          });
        }
        const id = `testing-admission-${crypto.randomUUID()}`;
        await runDb(
          resource.insertRun({
            runId: id,
            workflowName: "testing-framework",
            status: "running",
            createdAtMs: Date.now(),
            startedAtMs: Date.now(),
            heartbeatAtMs: null,
            runtimeOwnerId: "testing-framework"
          })
        );
        await runDb(resource.heartbeatRun(id, "testing-framework", Date.now()));
        const rows = await runDb(resource.listRuns(100, void 0, "testing-framework"));
        if (!rows.some((row) => row.runId === id))
          throw Object.assign(new Error("real-db admission write was not durably readable"), {
            code: "ADMISSION_FAILED"
          });
      },
      cleanup: async () => {
        const native = resource?.db?.$client;
        if (resource?.close) await resource.close();
        if (native) {
          try {
            native.query("SELECT 1").get();
            throw Object.assign(new Error("CLEANUP_LEAK: database handle remained open after adapter cleanup"), {
              code: "CLEANUP_LEAK"
            });
          } catch (error) {
            if (error.code === "CLEANUP_LEAK") throw error;
          }
        }
        resource = void 0;
      },
      runStep: async (operation, ...args) => {
        if (!resource) throw new Error("REAL_DB_NOT_ADMITTED");
        const requestedOperation = String(operation);
        const productionOperation = requestedOperation.replace(/#\d+$/, "");
        if (productionOperations.has(productionOperation)) {
          const bound = realDbCutPoints(resource)[productionOperation];
          if (typeof bound === "function") {
            const input = args.length === 1 ? args[0] : void 0;
            if (input && typeof input === "object" && !Array.isArray(input))
              return bound(input);
            return bound(...args);
          }
        }
        const direct = resource[String(operation)];
        if (typeof direct === "function")
          return runDb(direct.apply(resource, [...args]));
        if (productionOperations.has(productionOperation))
          throw Object.assign(
            new Error(
              `REAL_DB_OPERATION_UNAVAILABLE:${productionOperation} requires the admitted SmithersDb production method`
            ),
            { code: "ADMISSION_FAILED" }
          );
        const fn = resource.operations?.[String(operation)];
        if (!fn) throw new Error(`REAL_DB_OPERATION_UNAVAILABLE:${String(operation)}`);
        return fn.apply(resource, [...args]);
      },
      injectFault: async (fault2, context) => {
        if (!resource) throw new Error("REAL_DB_NOT_ADMITTED");
        const pair = `${fault2.operation}:${fault2.phase}`;
        if (!executableCutPoints.has(pair))
          throw Object.assign(new Error(`REAL_DB_FAULT_UNAVAILABLE:${pair}`), { code: "ADMISSION_FAILED" });
        const input = context?.input ?? void 0;
        const production = resource;
        const readRun = async (runId) => await runDb(production.getRun(runId));
        const runProjection = (run) => ({
          status: run?.status ?? null,
          runtimeOwnerId: run?.runtimeOwnerId ?? null,
          heartbeatAtMs: run?.heartbeatAtMs ?? null,
          cancelRequestedAtMs: run?.cancelRequestedAtMs ?? null
        });
        const observed = {};
        if (input?.runId && input.nodeId !== void 0 && typeof production.getAttempt === "function") {
          const attempt = await runDb(
            production.getAttempt(input.runId, input.nodeId, input.iteration ?? 0, input.attempt ?? 1)
          );
          if (attempt)
            observed.attempt = {
              state: attempt.state,
              finishedAtMs: attempt.finishedAtMs ?? null,
              runtimeOwnerId: attempt.runtimeOwnerId ?? null
            };
        }
        if (fault2.phase === "during-task" && context?.invoked === true && input?.runId && typeof production.getRun === "function") {
          if (fault2.operation === "heartbeat" && typeof resource.claimRunForResume === "function" && typeof resource.heartbeatRun === "function") {
            const before = await readRun(input.runId);
            const fencingOwner = "testing-fencing-owner";
            const previousOwner = typeof before?.runtimeOwnerId === "string" ? before.runtimeOwnerId : null;
            const claimHeartbeatAtMs = (before?.heartbeatAtMs ?? 0) + 1;
            const takeoverClaimed = previousOwner !== null && await runDb(
              resource.claimRunForResume({
                runId: input.runId,
                expectedStatus: before?.status ?? "running",
                expectedRuntimeOwnerId: previousOwner,
                expectedHeartbeatAtMs: before?.heartbeatAtMs ?? null,
                staleBeforeMs: claimHeartbeatAtMs,
                claimOwnerId: fencingOwner,
                claimHeartbeatAtMs,
                requireStale: false
              })
            ) === true;
            const rejectedHeartbeatAtMs = claimHeartbeatAtMs + 1;
            if (takeoverClaimed && previousOwner !== null)
              await runDb(resource.heartbeatRun(input.runId, previousOwner, rejectedHeartbeatAtMs));
            const after = await readRun(input.runId);
            observed.leaseTakeover = {
              executed: takeoverClaimed,
              previousOwner,
              fencingOwner,
              oldOwnerHeartbeatRejected: takeoverClaimed && after?.runtimeOwnerId === fencingOwner && after?.heartbeatAtMs === claimHeartbeatAtMs,
              before: runProjection(before),
              after: runProjection(after)
            };
          }
          if (fault2.operation === "cancellation" && typeof resource.completeRun === "function") {
            const before = await readRun(input.runId);
            const completionOwner = before?.runtimeOwnerId ?? "owner";
            const completionAdmitted = await runDb(
              resource.completeRun(input.runId, completionOwner, (before?.cancelRequestedAtMs ?? 0) + 1)
            ) === true;
            const after = await readRun(input.runId);
            observed.cancellationRace = {
              executed: true,
              cancelRequested: (before?.cancelRequestedAtMs ?? null) !== null,
              completionRejected: !completionAdmitted && after?.status !== "finished",
              winner: completionAdmitted ? "completion" : "cancellation",
              before: runProjection(before),
              after: runProjection(after)
            };
          }
        }
        if (input?.runId && typeof production.getRun === "function") {
          const run = await readRun(input.runId);
          if (run)
            observed.run = {
              status: run.status,
              runtimeOwnerId: run.runtimeOwnerId ?? null,
              heartbeatAtMs: run.heartbeatAtMs ?? null,
              cancelRequestedAtMs: run.cancelRequestedAtMs ?? null
            };
        }
        return {
          operation: fault2.operation,
          phase: fault2.phase,
          executed: true,
          invoked: context?.invoked === true,
          productionIdentity: "@smithers-orchestrator/db/adapter:SmithersDb",
          result: context?.result,
          observed
        };
      },
      serializeError: options.serializeError,
      extensionExecutors: options.extensionExecutors
    },
    "integration-real-db"
  );
};

// src/adapters/realProcessAdapter.ts
init_Harness();
import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import { dirname as dirname2, resolve as resolve2 } from "path";
var repositoryRunner = () => {
  let dir = dirname2(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    try {
      return realpathSync(resolve2(dir, "e2e/harness/engineChildRunner.ts"));
    } catch {
      dir = resolve2(dir, "..");
    }
  }
  throw Object.assign(new Error("real process admission requires the repository-owned engineChildRunner"), {
    code: "ADMISSION_FAILED"
  });
};
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
var verifiedChild = (resource, expectedRunner, nonce) => {
  const args = resource.child.spawnargs ?? [];
  if (resource.child.pid !== resource.pid || resource.pid <= 0 || resource.pid === process.pid) return false;
  if (String(args[0] ?? "").split("/").pop() !== "bun")
    return false;
  if (!args[1]) return false;
  try {
    if (realpathSync(String(args[1])) !== expectedRunner) return false;
  } catch {
    return false;
  }
  return args.some((arg) => String(arg) === nonce);
};
var verifyProtocol = async (resource, expectedRunner, nonce, marker) => {
  const args = resource.child?.spawnargs ?? [];
  const executable = args[0] ? String(args[0]).split("/").pop() : "";
  const productionRunner = args[1] !== void 0 && (() => {
    try {
      return realpathSync(String(args[1])) === expectedRunner;
    } catch {
      return false;
    }
  })();
  let stdout = "";
  resource.child?.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const deadline = Date.now() + 250;
  while (!stdout.includes(`${marker}:${nonce}`) && Date.now() < deadline)
    await new Promise((resolve3) => setTimeout(resolve3, 10));
  const nonceInArgv = args.some((arg) => String(arg) === nonce);
  const identityVerified = Boolean(resource.child) && verifiedChild(resource, expectedRunner, nonce) && Number.isInteger(resource.pid) && executable === "bun" && productionRunner && nonceInArgv;
  const markerVerified = stdout.includes(`${marker}:${nonce}`) || identityVerified && await resource.handshake(nonce) === nonce;
  return { verified: identityVerified && markerVerified, read: () => stdout };
};
var realProcessAdapter = (options) => {
  let admitted = false;
  let resource;
  const tracked = /* @__PURE__ */ new Set();
  const nonces = /* @__PURE__ */ new Set();
  const challenge = () => {
    const nonce = crypto.randomUUID();
    nonces.add(nonce);
    return nonce;
  };
  return registerTrustedAdapter(
    {
      identity: options.identity ?? "real-process:child",
      verifiedProductionIdentity: "smithers-engine:runWorkflow-child",
      supportedCutPoints: /* @__PURE__ */ new Set(["resume:during-task"]),
      admissionProbe: async () => {
        let suppliedRunner;
        let expectedRunner;
        try {
          suppliedRunner = realpathSync(options.runnerPath);
          expectedRunner = repositoryRunner();
        } catch (cause) {
          throw Object.assign(new Error("real process admission requires the repository-owned engineChildRunner"), {
            code: "ADMISSION_FAILED",
            cause
          });
        }
        if (suppliedRunner !== expectedRunner)
          throw Object.assign(new Error("real process admission rejected: runner identity is not repository-owned"), {
            code: "ADMISSION_FAILED",
            details: { suppliedRunner, expectedRunner }
          });
        const nonce = challenge();
        const probeChild = await options.probe(nonce);
        tracked.add(probeChild);
        const protocol = await verifyProtocol(probeChild, expectedRunner, nonce, "SMITHERS_ENGINE_HANDSHAKE=probe");
        nonces.delete(nonce);
        if (!protocol.verified || probeChild.healthy && !await probeChild.healthy())
          throw Object.assign(
            new Error(
              "real process failed admission: the probe child did not prove the repository production probe protocol"
            ),
            { code: "ADMISSION_FAILED" }
          );
        await exited(probeChild.child, 3e4);
        if (probeChild.child.exitCode !== 0)
          throw Object.assign(new Error("real process admission probe did not exit cleanly"), {
            code: "ADMISSION_FAILED",
            details: {
              pid: probeChild.pid,
              exitCode: probeChild.child.exitCode,
              signalCode: probeChild.child.signalCode
            }
          });
        if (protocol.read().includes("SMITHERS_ENGINE_HANDSHAKE=runWorkflow:"))
          throw Object.assign(new Error("real process admission probe illegally claimed the runWorkflow protocol"), {
            code: "ADMISSION_FAILED"
          });
        const durable = await probeChild.observeDurableState?.();
        if (durable && (durable.effectApplied || durable.outputPersisted))
          throw Object.assign(new Error("real process admission probe must not execute the target workflow"), {
            code: "ADMISSION_FAILED",
            details: durable
          });
        admitted = true;
      },
      cleanup: async () => {
        for (const childResource of tracked) {
          if (childResource.child.exitCode === null && childResource.child.signalCode === null)
            await childResource.kill("SIGKILL");
          await exited(childResource.child);
          await childResource.close();
          if (childResource.child.exitCode === null && childResource.child.signalCode === null)
            await childResource.kill("SIGKILL");
          if (childResource.child.exitCode === null && childResource.child.signalCode === null)
            throw Object.assign(new Error(`CLEANUP_LEAK: child/${childResource.pid}`), { code: "CLEANUP_LEAK" });
        }
        tracked.clear();
        resource = void 0;
        admitted = false;
      },
      runStep: async (operation, ...args) => {
        if (!admitted) throw new Error("REAL_PROCESS_NOT_ADMITTED");
        if (operation === "kill") {
          if (!resource) throw new Error("REAL_PROCESS_RUNWORKFLOW_NOT_STARTED");
          return resource.kill(String(args[0] ?? "SIGKILL"));
        }
        if (operation !== "runWorkflow")
          throw Object.assign(new Error(`REAL_PROCESS_OPERATION_UNAVAILABLE:${String(operation)}`), {
            code: "ADMISSION_FAILED"
          });
        let expectedRunner;
        try {
          expectedRunner = repositoryRunner();
        } catch (cause) {
          throw Object.assign(new Error("real process runWorkflow requires the repository-owned engineChildRunner"), {
            code: "ADMISSION_FAILED",
            cause
          });
        }
        const nonce = challenge();
        const spawned = await options.spawn(nonce);
        tracked.add(spawned);
        const protocol = await verifyProtocol(spawned, expectedRunner, nonce, "SMITHERS_ENGINE_HANDSHAKE=runWorkflow");
        nonces.delete(nonce);
        if (!protocol.verified)
          throw Object.assign(
            new Error("real process runWorkflow child failed executable identity and nonce challenge"),
            { code: "ADMISSION_FAILED" }
          );
        try {
          process.kill(spawned.pid, 0);
        } catch (cause) {
          throw Object.assign(new Error("real process runWorkflow child is not a live production child"), {
            code: "ADMISSION_FAILED",
            cause
          });
        }
        if (!spawned.observeDurableState)
          throw Object.assign(new Error("REAL_PROCESS_OBSERVATION_UNAVAILABLE"), { code: "ADMISSION_FAILED" });
        const deadline = Date.now() + 3e4;
        let inFlight = (await spawned.observeDurableState()).effectApplied;
        while (!inFlight && Date.now() < deadline && spawned.child.exitCode === null && spawned.child.signalCode === null) {
          await new Promise((resolve3) => setTimeout(resolve3, 50));
          inFlight = (await spawned.observeDurableState()).effectApplied;
        }
        if (!inFlight || spawned.child.exitCode !== null || spawned.child.signalCode !== null)
          throw Object.assign(new Error("real process runWorkflow is not observably in flight"), {
            code: "ADMISSION_FAILED",
            details: {
              pid: spawned.pid,
              inFlight,
              exitCode: spawned.child.exitCode,
              signalCode: spawned.child.signalCode
            }
          });
        resource = spawned;
        return spawned.pid;
      },
      injectFault: async (fault2) => {
        if (!admitted) throw new Error("REAL_PROCESS_NOT_ADMITTED");
        if (!resource) throw new Error("REAL_PROCESS_RUNWORKFLOW_NOT_STARTED");
        if (fault2.operation !== "resume" || fault2.phase !== "during-task")
          throw Object.assign(new Error(`REAL_PROCESS_FAULT_UNAVAILABLE:${fault2.operation}:${fault2.phase}`), {
            code: "ADMISSION_FAILED"
          });
        const preKill = await resource.observeDurableState?.();
        if (!preKill)
          throw Object.assign(new Error("REAL_PROCESS_OBSERVATION_UNAVAILABLE"), { code: "ADMISSION_FAILED" });
        await resource.kill("SIGKILL");
        await exited(resource.child);
        if (resource.child.signalCode !== "SIGKILL")
          throw Object.assign(new Error("real process replacement requires observed SIGKILL terminal event"), {
            code: "ADMISSION_FAILED",
            details: { pid: resource.pid, signalCode: resource.child.signalCode }
          });
        if (!resource.resume || !resource.observeDurableState)
          throw Object.assign(new Error("REAL_PROCESS_OBSERVATION_UNAVAILABLE"), { code: "ADMISSION_FAILED" });
        const nonce = challenge();
        const resumed = await resource.resume(nonce);
        if (resumed.pid === resource.pid)
          throw Object.assign(new Error("real process resume must create a distinct child"), {
            code: "ADMISSION_FAILED"
          });
        let resumedRunner;
        try {
          resumedRunner = repositoryRunner();
        } catch (cause) {
          throw Object.assign(new Error("resumed process runner is unavailable"), { code: "ADMISSION_FAILED", cause });
        }
        if (!verifiedChild(resumed, resumedRunner, nonce) || await resumed.handshake(nonce) !== nonce)
          throw Object.assign(new Error("resumed process failed executable identity and nonce challenge"), {
            code: "ADMISSION_FAILED"
          });
        const exitCode = resumed.child.exitCode;
        if (!resumed.resultStatus)
          throw Object.assign(
            new Error("real process resume must expose an adapter-owned production result observer"),
            { code: "ADMISSION_FAILED" }
          );
        const status = await resumed.resultStatus();
        if (!resumed.observeDurableState)
          throw Object.assign(new Error("REAL_PROCESS_RESUME_OBSERVATION_UNAVAILABLE"), { code: "ADMISSION_FAILED" });
        const resumedState = await resumed.observeDurableState();
        if (exitCode !== 0 || status !== "finished")
          throw Object.assign(new Error("real process resume did not produce a successful production result"), {
            code: "ADMISSION_FAILED",
            details: { pid: resumed.pid, exitCode, status }
          });
        if (!resumedState.outputPersisted)
          throw Object.assign(new Error("real process resume did not durably persist the expected output"), {
            code: "ADMISSION_FAILED",
            details: { pid: resumed.pid, outputPersisted: resumedState.outputPersisted }
          });
        tracked.add(resumed);
        resource = resumed;
        return {
          terminatedBy: "SIGKILL",
          preKillEffectApplied: preKill.effectApplied,
          journalWritten: preKill.journalWritten,
          outputPersisted: preKill.outputPersisted,
          resumed: true,
          resumedStatus: status,
          resumedEffectApplied: resumedState.effectApplied,
          resumedJournalWritten: resumedState.journalWritten,
          resumedOutputPersisted: resumedState.outputPersisted
        };
      },
      serializeError: options.serializeError,
      extensionExecutors: options.extensionExecutors
    },
    "e2e-real-process"
  );
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
  WorkflowCoverageError,
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
  coverWorkflow,
  cutPoint,
  dryRun,
  e2eDescriptor,
  e2eHarness,
  expectAmbiguity,
  expectEffect,
  expectFullCoverage,
  expectTrace,
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
  serializeBoundaryError,
  serializeReplayBundle,
  serializeSimulationDurableError,
  shrink,
  simMatchers,
  simulate,
  simulationNativeError,
  simulationSmithersError,
  step,
  toHaveExecuted,
  toHaveExecutedInOrder,
  toHaveFinished,
  unitSimHarness
};
