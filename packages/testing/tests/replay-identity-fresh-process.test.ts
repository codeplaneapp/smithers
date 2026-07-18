import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Adversarial fresh-process replay-identity proof. Each probe runs in a
 * SEPARATE bun process so nothing about builder registries, module state, or
 * construction history can leak between the two sides of a comparison. The
 * invariant under test: two fresh processes can never hold an equal replay
 * identity while producing different traces.
 */
const fixture = fileURLToPath(new URL("./fixtures/replay-identity-probe.ts", import.meta.url));
type ProbeResult = Readonly<{ threw?: string; identity?: string; binding?: string | null; status?: string; errorCode?: string | null; outputs?: unknown; traceDigest?: string; forgedConstructorCalls?: number; forgeryLive?: boolean | null; executedCallbackRuns?: number }>;
const probe = (form: string, value: string, entry: "source" | "shipped" = "source"): ProbeResult => {
  const child = spawnSync("bun", [fixture, form, value, entry], { encoding: "utf8", timeout: 30_000 });
  const line = child.stdout.trim().split("\n").at(-1);
  if (!line) throw new Error(`probe ${form}/${value} produced no output: ${child.stderr}`);
  return JSON.parse(line) as ProbeResult;
};

const AMBIGUOUS_FORMS = [
  "regular-function",
  "function-expression-named",
  "arrow-shorthand",
  "nested-block-shadow",
  "spread-capture",
  "nested-param-binder",
  "mutable-counter",
  "shadowed-undefined",
  "nested-arrow-var-shadow",
  "unicode-identifier",
  // called-versus-constructed: `new.target` inside the arrow is lexical state
  // of the enclosing factory invocation; "A" probes make(), "B" probes
  // new make() — both must be rejected, never share an anonymous identity.
  "new-target-meta",
  // Sol's indirect-global counterexamples: capability acquisition through the
  // prototype chain (computed access, dot access, and parameter-rooted
  // chains). Each evaluates `process.env`-dependent source from byte-identical
  // callback text, so anonymous admission would collide across processes.
  "computed-constructor",
  "dot-constructor",
  "param-constructor",
  // Sol's regex-literal counterexample: `(value)=>()=>[/var value/, value]`
  // produced identical anonymous bindings and replay identities in two Bun
  // processes with divergent outputs, because the unlexed regex TEXT credited
  // `value` as a local. Every regex-carrying form must be rejected.
  "regex-var-capture",
  "regex-let-capture",
  "regex-charclass",
  // Sol's round-4 counterexample family: implicit coercion, allocation, and
  // thenable adoption walk MUTABLE intrinsics (`Array.prototype.toString`,
  // `Array.prototype.toJSON`, `Object.prototype.then`), so byte-identical
  // capture-free source still diverges across fresh processes with different
  // prototype state. `() => [] + []` produced one anonymous identity with
  // outputs "AA" versus "BB"; each of these forms must be rejected.
  "array-coercion-prototype",
  "array-tojson-prototype",
  "await-thenable-prototype",
  "async-arrow",
  "arithmetic-comparison",
  "loose-equality",
  // Sol's round-6 counterexample: `(_runtime, input) => input != "A"` was
  // admitted (the `!` scanned as boolean-not, the `=` as assignment) and
  // diverged false/true across fresh processes under a per-process
  // `Object.prototype[Symbol.toPrimitive]` mutation while sharing one
  // anonymous binding and replay identity.
  "loose-inequality-toprimitive",
  "object-literal-alloc",
  // Sol's round-7 counterexample: the REFLECTION PRIMITIVE itself
  // (`Function.prototype.toString`) forged post-import to report the same
  // stateless-looking source for two different ordinary closures. The builder
  // reads source through the intrinsic captured at module initialization, so
  // the real capturing source is seen and both closures are rejected.
  "forged-tostring-post",
] as const;

describe("fresh-process replay identity", () => {
  test("unprovable closure forms are rejected in fresh processes instead of colliding", () => {
    for (const form of AMBIGUOUS_FORMS) {
      const a = probe(form, "A");
      const b = probe(form, "B");
      expect({ form, code: a.threw }).toEqual({ form, code: "RUNNER_BINDING_AMBIGUOUS" });
      expect({ form, code: b.threw }).toEqual({ form, code: "RUNNER_BINDING_AMBIGUOUS" });
    }
  }, { timeout: 120_000 });

  test("the SHIPPED artifact rejects the same fresh-process capability counterexamples", () => {
    // Sol's evidence reproduced the collisions against src/index.js as well as
    // the TypeScript source; the committed bundle must reject identically.
    for (const form of ["regular-function", "computed-constructor", "dot-constructor", "param-constructor", "regex-var-capture", "regex-let-capture", "regex-charclass", "array-coercion-prototype", "array-tojson-prototype", "await-thenable-prototype", "async-arrow", "arithmetic-comparison", "loose-equality", "loose-inequality-toprimitive", "object-literal-alloc", "forged-tostring-post"] as const) {
      for (const value of ["A", "B"] as const) {
        expect({ form, value, code: probe(form, value, "shipped").threw }).toEqual({ form, value, code: "RUNNER_BINDING_AMBIGUOUS" });
      }
    }
  }, { timeout: 240_000 });

  test("caller-forged anonymous-namespace bindings are rejected in both entrypoints", () => {
    // An explicit runnerBinding in the framework-issued `anonymous:` namespace
    // would let two processes share a content-addressed identity while naming
    // different executables — the same collision by forgery instead of
    // heuristic. The namespace is reserved.
    for (const entry of ["source", "shipped"] as const) {
      for (const value of ["A", "B"] as const) {
        expect({ entry, value, code: probe("forged-anonymous-binding", value, entry).threw }).toEqual({ entry, value, code: "RUNNER_BINDING_CONFLICT" });
      }
    }
  }, { timeout: 120_000 });

  test("unbound callbacks are rejected outright — anonymous executable identities are retired", () => {
    // These forms were previously ADMITTED under content-addressed anonymous
    // identities (provably stateless grammar). Sol's round-8 counterexample
    // proved the identity was only as trustworthy as the mutable pre-import
    // `Function` constructor that compiled it, so the namespace is retired:
    // the provable subset now fails closed with RUNNER_BINDING_REQUIRED in
    // every fresh process and no identity is ever minted.
    for (const entry of ["source", "shipped"] as const) {
      for (const form of ["stateless-arrow", "stateless-passthrough", "object-input-passthrough", "forged-tostring-pre"] as const) {
        const a = probe(form, "A", entry);
        const b = probe(form, "B", entry);
        expect({ entry, form, code: a.threw }).toEqual({ entry, form, code: "RUNNER_BINDING_REQUIRED" });
        expect({ entry, form, code: b.threw }).toEqual({ entry, form, code: "RUNNER_BINDING_REQUIRED" });
      }
    }
  }, { timeout: 240_000 });

  test("a global Function constructor forged BEFORE package import cannot mint an identity or reach any executable", () => {
    // Sol's round-8 reproduction verbatim: `globalThis.Function` (and
    // `Function.prototype.constructor`) replaced before the package imports,
    // real `Function.prototype` and real toString preserved, the forged
    // compiler returning process-specific runners. Under the retired
    // recompilation design both fresh processes minted equal anonymous
    // bindings and replay identities around divergent forged behavior. Now:
    // the anonymous half is rejected without minting an identity, the bound
    // half executes the caller's ORIGINAL callback with equal identities and
    // byte-identical traces, and the forged constructor is NEVER invoked by
    // the framework in either half.
    for (const entry of ["source", "shipped"] as const) {
      const anonymousA = probe("forged-function-pre-anonymous", "A", entry);
      const anonymousB = probe("forged-function-pre-anonymous", "B", entry);
      expect({ entry, code: anonymousA.threw, calls: anonymousA.forgedConstructorCalls, live: anonymousA.forgeryLive }).toEqual({ entry, code: "RUNNER_BINDING_REQUIRED", calls: 0, live: true });
      expect({ entry, code: anonymousB.threw, calls: anonymousB.forgedConstructorCalls, live: anonymousB.forgeryLive }).toEqual({ entry, code: "RUNNER_BINDING_REQUIRED", calls: 0, live: true });
      const boundA = probe("forged-function-pre-bound", "A", entry);
      const boundB = probe("forged-function-pre-bound", "B", entry);
      expect({ entry, threw: boundA.threw ?? boundB.threw }).toEqual({ entry, threw: undefined });
      expect({ entry, status: boundA.status, calls: boundA.forgedConstructorCalls, live: boundA.forgeryLive }).toEqual({ entry, status: "finished", calls: 0, live: true });
      expect({ entry, status: boundB.status, calls: boundB.forgedConstructorCalls, live: boundB.forgeryLive }).toEqual({ entry, status: "finished", calls: 0, live: true });
      // The forged compiler's process-specific behavior never surfaces: the
      // caller-bound original ran in both processes.
      expect(boundA.outputs).toEqual({ probe: "same" });
      expect(boundB.outputs).toEqual({ probe: "same" });
      expect(boundA.identity).toBe(boundB.identity!);
      expect(boundA.binding).toBe("fixture:forged-function:v1");
      expect(boundA.traceDigest).toBe(boundB.traceDigest!);
    }
  }, { timeout: 240_000 });

  test("an empty runnerBinding cannot revive an anonymous executable identity in either entrypoint", () => {
    // Sol's round-9 reproduction: `runnerBinding: ""` passed the explicitness
    // check (`!== undefined`), truthiness spreads then dropped it from the
    // canonical AST, and the builder registry still executed the callback —
    // two fresh processes finished with binding null, equal replay identity
    // ri1:6732…, and divergent traces (resultDigest "A" versus "B"). The
    // builder must now reject empty and whitespace-only bindings without
    // minting an identity or running the callback, and runScenario admission
    // must refuse the hand-crafted twins: an invalid-binding step paired with
    // an out-of-band runner (RUNNER_BINDING_REQUIRED — an executable with no
    // valid canonical name) and the inert malformed binding itself
    // (RUNNER_BINDING_INVALID).
    for (const entry of ["source", "shipped"] as const) {
      for (const value of ["A", "B"] as const) {
        for (const form of ["empty-binding", "whitespace-binding"] as const) {
          const rejected = probe(form, value, entry);
          expect({ entry, form, value, code: rejected.threw, identity: rejected.identity, ran: rejected.executedCallbackRuns }).toEqual({ entry, form, value, code: "RUNNER_BINDING_INVALID", identity: undefined, ran: 0 });
        }
        const bound = probe("handcrafted-empty-binding", value, entry);
        expect({ entry, value, status: bound.status, code: bound.errorCode, ran: bound.executedCallbackRuns, outputs: bound.outputs }).toEqual({ entry, value, status: "failed", code: "RUNNER_BINDING_REQUIRED", ran: 0, outputs: {} });
        const inert = probe("handcrafted-empty-binding-inert", value, entry);
        expect({ entry, value, status: inert.status, code: inert.errorCode, ran: inert.executedCallbackRuns }).toEqual({ entry, value, status: "failed", code: "RUNNER_BINDING_INVALID", ran: 0 });
      }
      // Equal replay identities cannot produce different trace digests: the
      // hand-crafted twins share one AST across both process values, and with
      // no callback ever executing their rejections are byte-identical.
      const boundA = probe("handcrafted-empty-binding", "A", entry);
      const boundB = probe("handcrafted-empty-binding", "B", entry);
      expect(boundA.identity).toBe(boundB.identity!);
      expect(boundA.traceDigest).toBe(boundB.traceDigest!);
    }
  }, { timeout: 240_000 });

  test("explicitly bound callbacks replay byte-identically across fresh processes", () => {
    for (const form of ["bound-runtime-effect"] as const) {
      const a = probe(form, "A");
      const b = probe(form, "B");
      expect(a.threw).toBeUndefined();
      expect(a.status).toBe("finished");
      expect(a.identity).toBe(b.identity!);
      expect(a.binding).toBe(b.binding!);
      expect(a.outputs).toEqual(b.outputs);
      expect(a.traceDigest).toBe(b.traceDigest!);
    }
  }, { timeout: 60_000 });

  test("caller-supplied executable identity flows into the canonical replay identity", () => {
    const a = probe("explicit-binding-distinct", "A");
    const b = probe("explicit-binding-distinct", "B");
    expect(a.threw).toBeUndefined();
    expect(b.threw).toBeUndefined();
    expect(a.binding).toBe("fixture:value:A");
    expect(b.binding).toBe("fixture:value:B");
    expect(a.identity).not.toBe(b.identity!);
    expect(a.outputs).toEqual({ probe: "A" });
    expect(b.outputs).toEqual({ probe: "B" });
  }, { timeout: 60_000 });

  test("no pair of fresh processes shares a replay identity with divergent traces", () => {
    const results: ProbeResult[] = [];
    for (const form of [...AMBIGUOUS_FORMS, "forged-tostring-pre", "forged-anonymous-binding", "forged-function-pre-anonymous", "forged-function-pre-bound", "object-input-passthrough", "explicit-binding-distinct", "stateless-arrow", "stateless-passthrough", "bound-runtime-effect", "empty-binding", "whitespace-binding", "handcrafted-empty-binding", "handcrafted-empty-binding-inert"]) {
      for (const value of ["A", "B"]) results.push(probe(form, value));
    }
    const byIdentity = new Map<string, Set<string>>();
    for (const result of results) {
      if (!result.identity || !result.traceDigest) continue;
      const digests = byIdentity.get(result.identity) ?? new Set<string>();
      digests.add(result.traceDigest);
      byIdentity.set(result.identity, digests);
    }
    expect(byIdentity.size).toBeGreaterThan(0);
    for (const [identity, digests] of byIdentity) expect({ identity, digests: digests.size }).toEqual({ identity, digests: 1 });
  }, { timeout: 240_000 });
});
