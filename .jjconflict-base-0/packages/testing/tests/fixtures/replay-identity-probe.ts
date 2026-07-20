/**
 * Fresh-process replay-identity probe. Spawned as a SEPARATE bun process by
 * replay-identity-fresh-process.test.ts:
 *
 *   bun replay-identity-probe.ts <form> <value>
 *
 * Builds a step runner from the named closure-factory form with a
 * process-specific captured value, then prints one JSON line describing either
 * the builder rejection or the executed scenario (replay identity, binding,
 * outputs, trace digest). The parent asserts that no two fresh processes can
 * ever hold an equal replay identity while producing different traces.
 */
import { createHash } from "node:crypto";
import type { ScenarioStep, ScenarioValue, StepRunner } from "../../src/index.ts";

// Third argv selects the runtime entrypoint: the tsconfig-alias TypeScript
// source (default) or the COMMITTED src/index.js package artifact, so the
// adversarial forms are proven rejected in the shipped bundle too.
const entry = process.argv[4] === "shipped" ? "../../src/index.js" : "../../src/index.ts";
// Deterministic probe for the PARENT's spawn harness: die with a distinctive
// status before any JSON is printed so the parent can prove its no-output
// failure report carries the child's exit status/signal instead of the opaque
// "produced no output" the old blocking helper raised.
if (process.argv[2] === "diagnostics-exit-without-output") process.exit(43);
// Sol's round-7 counterexample: the REFLECTION PRIMITIVE itself is a mutable
// intrinsic. The forged toString reports the same stateless-looking source
// for every function, so two different closures would share one anonymous
// identity. The `pre` form installs the forgery BEFORE the framework module
// initializes (the captured intrinsic IS the forgery); the `post` form
// installs it after import (the captured intrinsic predates it).
const forgedStatelessSource = `(_runtime, input) => "same"`;
const forgeFunctionToString = () => {
  (Function.prototype as unknown as { toString: unknown }).toString = function toString() { return forgedStatelessSource; };
};
if (process.argv[2] === "forged-tostring-pre") forgeFunctionToString();
// Sol's round-8 counterexample: the COMPILATION primitive itself is mutable
// realm state. Replacing `globalThis.Function` BEFORE the framework module
// initializes (real `Function.prototype` and real toString preserved, so
// reflection and instanceof still behave) hands the builder a forged
// "intrinsic" compiler that binds process-specific behavior to whatever
// source it is given — under the retired recompilation design two fresh
// processes minted equal anonymous bindings and replay identities around
// divergent forged executables. The forgery counts every invocation so the
// parent can assert the framework NEVER consults a function-construction
// primitive; `Function.prototype.constructor` is forged too, closing the
// `(function () {}).constructor` route sol's exact reproduction left real.
let forgedConstructorCalls = 0;
let forgedProcessValue: string | undefined;
const forgeFunctionConstructor = (processValue: string) => {
  forgedProcessValue = processValue;
  const RealFunction = Function;
  const forged = function Function(..._args: string[]) {
    forgedConstructorCalls++;
    return () => () => processValue;
  } as unknown as FunctionConstructor;
  (forged as unknown as { prototype: unknown }).prototype = RealFunction.prototype;
  (globalThis as unknown as { Function: unknown }).Function = forged;
  (RealFunction.prototype as unknown as { constructor: unknown }).constructor = forged;
};
if (process.argv[2]?.startsWith("forged-function-pre")) forgeFunctionConstructor(process.argv[3] ?? "");
// Executed AFTER the framework phase: proves the adversary was genuinely live
// in this realm the whole time (not a vacuous zero-count from a broken
// forgery). Every constructor route — the global binding, a function
// literal's `.constructor`, and `Function.prototype.constructor` — must
// resolve to the forgery and yield the process-specific runner, and doing so
// must increment the call counter the framework phase left untouched.
const proveForgeryLive = (): boolean | null => {
  if (forgedProcessValue === undefined) return null;
  const before = forgedConstructorCalls;
  const viaGlobal = (new (globalThis as unknown as { Function: new (source: string) => () => () => string }).Function("return 0"))()();
  const viaLiteral = (new ((function () {}).constructor as unknown as new (source: string) => () => () => string)("return 0"))()();
  const viaPrototype = (new (Function.prototype.constructor as unknown as new (source: string) => () => () => string)("return 0"))()();
  return viaGlobal === forgedProcessValue && viaLiteral === forgedProcessValue && viaPrototype === forgedProcessValue && forgedConstructorCalls === before + 3;
};
const { runScenario, scenario, step } = (await import(new URL(entry, import.meta.url).href)) as typeof import("../../src/index.ts");

// Incremented by the empty-binding adversary callbacks so the parent can
// assert a rejected executable NEVER ran — a zero count plus a rejection code
// is the proof that no identity was minted around live behavior.
let executedCallbackRuns = 0;
type Probe = Readonly<{ run?: StepRunner; runnerBinding?: string; input?: ScenarioValue; handcraftedBinding?: string; stepRunners?: Record<string, StepRunner> }>;
const factories: Record<string, (value: string) => Probe> = {
  // Sol's fresh-process counterexample: ordinary-function closure with
  // byte-identical source across processes but different captured values.
  "regular-function": (value) => ({ run: function () { return value; } }),
  "function-expression-named": (value) => { const captured = value; return { run: function inner() { return captured; } }; },
  "arrow-shorthand": (value) => ({ run: () => ({ value }) }),
  "nested-block-shadow": (value) => ({ run: () => { { const value = "shadow"; void value; } return value; } }),
  "spread-capture": (value) => ({ run: () => [...value] }),
  "nested-param-binder": (value) => ({ run: () => [value, ((x: string) => x)("x")] }),
  "mutable-counter": (value) => { let n = value.length; return { run: () => ++n }; },
  "shadowed-undefined": (value) => ((undefined) => ({ run: () => undefined as unknown }))(value),
  // Sol's nested-scope counterexample: the `var` inside the nested arrow is
  // scoped to THAT arrow, so the outer `return value` still reads the capture
  // while a scope-blind scan credits `value` as a local.
  "nested-arrow-var-shadow": (value) => ({ run: () => { (() => { var value = "nested"; void value; })(); return value; } }),
  // Sol's Unicode counterexample: a dynamically constructed closure whose
  // identifiers are outside ASCII, invisible to an ASCII-only tokenizer.
  "unicode-identifier": (value) => {
    const make = new Function("значение", "return () => { var результат = значение; return результат; }") as (v: string) => () => string;
    return { run: make(value) };
  },
  // Sol's meta-property counterexample: `new.target` is LEXICALLY captured by
  // the arrow, so byte-identical source answers differently depending on how
  // the ENCLOSING factory was invoked — value "A" obtains the runner from
  // `make()` ("called"), value "B" from `new make()` ("constructed").
  "new-target-meta": (value) => {
    function make() { return () => (new.target ? "constructed" : "called"); }
    const construct = make as unknown as new () => StepRunner;
    return { run: value === "B" ? new construct() : (make() as StepRunner) };
  },
  // Sol's indirect-global counterexample: byte-identical source with ZERO
  // identifiers after string-literal stripping, yet it reaches the Function
  // constructor through the prototype chain and evaluates source that reads
  // process state — two fresh processes with different PROBE values produced
  // identical anonymous identities with divergent traces.
  "computed-constructor": (value) => {
    process.env.SMITHERS_REPLAY_PROBE_VALUE = value;
    return { run: () => (({}) as unknown as Record<string, Record<string, (source: string) => () => string>>)["constructor"]!["constructor"]!("return process.env.SMITHERS_REPLAY_PROBE_VALUE")() };
  },
  // The dot-access twin of the computed form: same capability chain with no
  // computed access at all.
  "dot-constructor": (value) => {
    process.env.SMITHERS_REPLAY_PROBE_VALUE = value;
    return { run: () => (({}).constructor.constructor as (source: string) => () => string)("return process.env.SMITHERS_REPLAY_PROBE_VALUE")() };
  },
  // The parameter-chain twin: the only base object is the runner's own
  // parameter, so "references nothing but its parameters" is still not
  // statelessness once member access is allowed.
  "param-constructor": (value) => {
    process.env.SMITHERS_REPLAY_PROBE_VALUE = value;
    return { run: (runtime) => ((runtime as unknown as { constructor: { constructor: (source: string) => () => string } }).constructor.constructor("return process.env.SMITHERS_REPLAY_PROBE_VALUE")()) };
  },
  // Sol's regular-expression counterexample: a scanner that does not lex
  // regex literals credits the regex TEXT `var value` as a local declaration,
  // so byte-identical source admits different captured values.
  "regex-var-capture": (value) => ({ run: () => [/var value/, value] }),
  // The `let` twin of the regex declaration-laundering form.
  "regex-let-capture": (value) => ({ run: () => [/let value = 0/, value] }),
  // A character-class regex: unparsed regex text is rejected in every shape,
  // not just the declaration-keyword one.
  "regex-charclass": (value) => ({ run: () => [/[/]/, value] }),
  // Sol's round-4 counterexample VERBATIM: `() => [] + []` is capture-free and
  // byte-identical, but `+` applies ToPrimitive to the arrays, which walks the
  // MUTABLE `Array.prototype.toString` — set per-process here exactly as Sol's
  // probe did. Admission produced one anonymous identity with outputs "AA"
  // versus "BB"; every coercion-capable operator is now outside the grammar.
  "array-coercion-prototype": (value) => {
    (Array.prototype as unknown as { toString: () => string }).toString = function () { return value; };
    return { run: () => ([] as unknown as string) + ([] as unknown as string) };
  },
  // The serialization twin: a pure array ALLOCATION with no operator at all
  // still reaches the mutable `Array.prototype.toJSON` when the result is
  // serialized, so allocation itself is outside the grammar.
  "array-tojson-prototype": (value) => {
    (Array.prototype as unknown as { toJSON: () => string }).toJSON = function () { return value; };
    return { run: () => [0] };
  },
  // The async twin: awaiting (or resolving with) an object performs thenable
  // adoption — a mutable `Object.prototype.then` lookup — so `async`/`await`
  // are outside the grammar even when every identifier is a parameter.
  "await-thenable-prototype": (value) => {
    (Object.prototype as unknown as { then: (resolve: (v: string) => void) => void }).then = function (resolve) { resolve(value); };
    return { run: async (_runtime, input) => await input, input: { fixed: true } };
  },
  // Capture-free async arrow: rejected wholesale, not just when awaiting.
  "async-arrow": () => ({ run: async () => "same" }),
  // Relational comparison applies ToPrimitive to object operands; operand
  // types are not provable from source, so `<` is outside the grammar.
  "arithmetic-comparison": () => ({ run: (_runtime, input) => (input as number) < 2 }),
  // Loose equality applies ToPrimitive to object operands.
  "loose-equality": () => ({ run: (_runtime, input) => (input as unknown) == null }),
  // Sol's round-6 counterexample VERBATIM: loose INEQUALITY slipped through
  // when the scanner consumed the `!` as boolean-not and the trailing `=` as
  // assignment. The object input reaches ToPrimitive through the mutable
  // `Object.prototype[Symbol.toPrimitive]`, mutated per process exactly as
  // Sol's probe did — admission produced one anonymous identity and one
  // replay identity with outputs false versus true and divergent traces. The
  // primitive-result guard cannot catch it (the result is a boolean), so
  // rejection at step() is the only sound outcome.
  "loose-inequality-toprimitive": (value) => {
    (Object.prototype as unknown as Record<symbol, unknown>)[Symbol.toPrimitive] = function () { return value; };
    return { run: (_runtime, input) => (input as string) != "A", input: { fixed: true } };
  },
  // Pure object allocation: `toJSON`/`toString`/`valueOf` on the allocated
  // object are mutable prototype lookups at the first serialization boundary.
  "object-literal-alloc": () => ({ run: () => ({ fixedKey: 0 }) }),
  // Sol's round-7 reflection-forgery counterexample, POST-import: the builder
  // reads source through the intrinsic captured at module initialization, so
  // the REAL capturing source is what admission sees and the closure is
  // rejected — the forgery cannot mint an anonymous identity.
  "forged-tostring-post": (value) => {
    forgeFunctionToString();
    return { run: function () { return value; } };
  },
  // The PRE-import twin: the forgery IS the captured intrinsic, so the forged
  // source is admitted — but the executable is RECOMPILED from that same
  // digested source, so both processes run the forged source and equal replay
  // identities produce byte-identical outputs and traces, never a divergence.
  "forged-tostring-pre": (value) => ({ run: function () { return value; } }),
  // A caller-forged `anonymous:` binding would collide with framework-issued
  // content-addressed identities while naming a different executable.
  "forged-anonymous-binding": (value) => ({ run: function () { return value; }, runnerBinding: "anonymous:forged" }),
  // ADMITTED passthrough whose object result must be stopped by the kernel's
  // primitive-result guard BEFORE `Promise.resolve` can perform thenable
  // adoption on it. No prototype mutation here: a process-global
  // `Object.prototype.then` poisons EVERY awaited plain object in the host
  // (including this fixture's own reporting), so the proof is the type-based
  // guard itself — the old kernel finished with the object output, the fixed
  // kernel fails deterministically with a typed error and equal traces.
  "object-input-passthrough": () => ({ run: (_runtime, input) => input, input: { fixed: true } }),
  // Sol's round-8 pre-import Function-constructor adversary, both halves. The
  // anonymous half replays sol's exact reproduction: a provably-stateless
  // callback that the retired design would have recompiled through the forged
  // constructor into process-divergent behavior under one shared identity —
  // it must now be rejected without minting any identity at all. The bound
  // half proves the forgery is inert for the surviving executable path: the
  // caller-bound ORIGINAL callback runs, the forged constructor is never
  // invoked, and equal identities yield byte-identical outputs and traces.
  "forged-function-pre-anonymous": () => ({ run: () => "same" }),
  "forged-function-pre-bound": () => ({ run: function () { return "same"; }, runnerBinding: "fixture:forged-function:v1" }),
  // Sol's round-9 counterexample: `runnerBinding: ""` counted as explicit
  // (bypassing RUNNER_BINDING_REQUIRED), truthiness spreads dropped it from
  // the canonical AST, and the builder registry still held the executable —
  // two fresh processes finished with binding null, one shared replay
  // identity, and divergent process-captured traces. The builder must reject
  // the empty (and whitespace-only) binding outright: no identity minted, no
  // registration, the callback never runs.
  "empty-binding": (value) => ({ run: function () { executedCallbackRuns++; return value; }, runnerBinding: "" }),
  "whitespace-binding": (value) => ({ run: function () { executedCallbackRuns++; return value; }, runnerBinding: "   " }),
  // The hand-crafted twins: an AST is plain data, so a step carrying the
  // invalid empty binding can bypass the builder entirely. Admission must
  // refuse it — with an out-of-band runner attached (the runner requires a
  // VALID canonical binding) and equally when inert (malformed identity is
  // rejected even with no executable in sight).
  "handcrafted-empty-binding": (value) => ({ handcraftedBinding: "", stepRunners: { probe: function () { executedCallbackRuns++; return value; } } }),
  "handcrafted-empty-binding-inert": () => ({ handcraftedBinding: "" }),
  "explicit-binding-distinct": (value) => ({ run: function () { return value; }, runnerBinding: `fixture:value:${value}` }),
  "stateless-arrow": () => ({ run: () => "same" }),
  "stateless-passthrough": () => ({ run: (_runtime, input) => input ?? "fallback" }),
  // The taskRuntime authoring pattern is member access and therefore requires
  // an explicit binding; bound, it must replay byte-identically.
  "bound-runtime-effect": () => ({ run: (runtime) => runtime.effect("write", () => "ok"), runnerBinding: "fixture:runtime-effect:v1" }),
};

const [form, value] = process.argv.slice(2);
const factory = factories[form ?? ""];
if (!factory || value === undefined) {
  console.log(JSON.stringify({ threw: `unknown form ${form}` }));
  process.exit(1);
}
const probe = factory(value);
try {
  // The binding spread is on `undefined`, NEVER truthiness: an empty-string
  // binding must reach step() as supplied so the builder's own rejection is
  // what this probe observes, not a fixture-side laundering of the input.
  const probeStep = probe.handcraftedBinding !== undefined
    ? (Object.freeze({ kind: "step", id: "probe", input: probe.input ?? "seed-input", dependsOn: [], capabilities: [], runnerBinding: probe.handcraftedBinding }) as unknown as ScenarioStep)
    : step("probe", { input: probe.input ?? "seed-input", ...(probe.run ? { run: probe.run } : {}), ...(probe.runnerBinding !== undefined ? { runnerBinding: probe.runnerBinding } : {}) });
  const ast = scenario("fresh-process-identity", { seed: 7, steps: [probeStep] });
  const result = await runScenario(ast, { seed: 7, ...(probe.stepRunners ? { stepRunners: probe.stepRunners } : {}) });
  const projection = JSON.parse(JSON.stringify({ outputs: result.outputs, trace: result.trace }));
  const frameworkConstructorCalls = forgedConstructorCalls;
  console.log(JSON.stringify({
    identity: result.replayIdentity,
    binding: ast.steps[0]?.runnerBinding ?? null,
    status: result.status,
    errorCode: result.error?.code ?? null,
    outputs: projection.outputs,
    traceDigest: createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
    forgedConstructorCalls: frameworkConstructorCalls,
    forgeryLive: proveForgeryLive(),
    executedCallbackRuns,
  }));
} catch (error) {
  const frameworkConstructorCalls = forgedConstructorCalls;
  console.log(JSON.stringify({ threw: (error as { code?: string }).code ?? String(error), forgedConstructorCalls: frameworkConstructorCalls, forgeryLive: proveForgeryLive(), executedCallbackRuns }));
}
