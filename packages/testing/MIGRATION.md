# Testing harness migration

Descriptor-only `integrationHarness()` and `e2eDescriptor()` remain available
for compatibility, but they deliberately cannot pass admission. A real claim
requires an executable adapter whose admission probe touches the production
database or process.

```ts
// compatibility: reports capability-failure for real capabilities
const oldHarness = integrationHarness();

// production-backed boundary
const harness = integrationHarness({
  adapter: realDbAdapter({ open: async () => openProductionSmithersDb() }),
});
```

The same rule applies to `e2eHarness({ adapter: realProcessAdapter(...) })`.
Unit scenarios remain plain TypeScript: callbacks use `taskRuntime.effect()`
for controllable effects and `taskRuntime.opaque()` when an external effect is
intentionally uncontrollable. External exactly-once claims are rejected; use
at-least-once, an idempotency key, or a journal CAS claim.

## Cut points fire only at their operation's transition

A declared fault names an operation/phase pair and fires ONLY when that
operation actually transitions: `effect` faults inside `taskRuntime.effect`,
`event-append` faults at a registered wakeup's append (a during-task drop
surfaces as the injected fault, an after-task drop as `LOST_WAKEUP` — both
with the `lost-wakeup` ambiguity), `completion-cas` faults at the terminal
completion transition of a completed callback, and the task/lease-holding
family (`task`, `resume`, `lease`, `heartbeat`, `cancellation`) at the
in-flight callback rendezvous. A callback that never crosses the named
boundary is a non-occurrence: its own result or error stands and no fault,
receipt, or ambiguity is fabricated. An `inject-fault` control ARMS its
declared fault at the task rendezvous; if the named operation never
transitions, the run fails with `CONTROL_UNCONSUMED` (a supplied control is
not an observation), never with `DURABILITY_FAULT_INJECTED`.

## Every run callback requires an explicit runnerBinding

Anonymous (no `runnerBinding`) executable identities are RETIRED. A `run`
callback without an explicit binding now throws at `step()`:
`RUNNER_BINDING_AMBIGUOUS` when its source is not provably stateless (the
historical diagnostic, unchanged), and `RUNNER_BINDING_REQUIRED` when the
source IS provably stateless — the framework no longer issues a
content-addressed identity even for the provable subset. The rejection
classes below are kept because they still explain the `AMBIGUOUS` diagnostic
and document why each form could never have carried an anonymous identity.

JavaScript exposes no closure
environment,
so any capture-capable form — ordinary `function () {}` closures, shorthand
object captures, spread/global references, parameterised nested arrows,
`this`, template literals, mutable state, non-ASCII identifiers or `\u`
escapes, lexical meta-properties such as `new.target` (identical source
answers called-versus-constructed from the enclosing factory), and any
`var`/`let`/`const` declaration alongside a nested arrow (the declaration's
scope cannot be attributed without lexical analysis) — throws
`RUNNER_BINDING_AMBIGUOUS` instead of silently sharing a replay identity
across processes.

Member access of ANY form — dot, optional chaining, or computed `[...]` — is
also rejected, including on the callback's own parameters. Property access is
capability acquisition, not mere reading: every object reaches the `Function`
constructor through its prototype chain
(`({})["constructor"]["constructor"]("return process.env.X")()` and its dot
and parameter-rooted twins evaluate arbitrary process-dependent source from
byte-identical callback text), and no narrower allowance survives composition
through locals. In particular, every `taskRuntime`-using callback now
requires an explicit binding.

Regular-expression literals and division are also outside the provable
grammar: distinguishing `/regex/` from `a / b` needs a real JS lexer, and an
unlexed regex can launder declaration keywords through its text
(`() => [/var value/, value]` would credit the captured `value` as a local).
Any `/` that survives string/comment stripping therefore throws
`RUNNER_BINDING_AMBIGUOUS`; a dividing or regex-using callback needs an
explicit `runnerBinding`.

Object/array allocation, every coercion-capable operator, and `async` forms
are outside the grammar too. Statelessness of the SOURCE is not enough:
evaluation must also be independent of ambient mutable prototypes, or two
fresh processes with equal replay identities produce different traces.
`() => [] + []` is capture-free, yet `+` applies ToPrimitive to the arrays
and walks the mutable `Array.prototype.toString` (outputs `"AA"` versus
`"BB"` under per-process mutation); a bare `[0]` or `{ key: 0 }` reaches the
mutable `toJSON`/`toString`/`valueOf` protocols at the first serialization
boundary; relational/loose-equality/arithmetic/bitwise operators coerce
object operands whose types are unprovable from source; and an `async`
callback's settlement performs thenable adoption — a mutable
`Object.prototype.then` lookup. Each of these forms throws
`RUNNER_BINDING_AMBIGUOUS`.

The retirement itself closes the last channel. The previous design captured
`Function.prototype.toString` at module initialization (a post-import forgery
still cannot substitute source — the scan reads the REAL source and rejects a
capturing closure) and RECOMPILED admitted source through the captured global
`Function` constructor so digest and behavior were the same bytes. But the
constructor is mutable realm state too: replacing `globalThis.Function`
BEFORE the package imports (real `Function.prototype` preserved) hands the
builder a forged compiler, and two fresh processes then mint equal anonymous
bindings and replay identities around whatever divergent behavior the forgery
returns. Every alternative execution primitive
(`Function.prototype.constructor`, `(function () {}).constructor`, `eval`,
generator/async constructor chains) is equally forgeable pre-import, so the
framework now issues NO anonymous executable identity: the provable subset
throws `RUNNER_BINDING_REQUIRED`, the framework never invokes any
function-construction primitive, and the retired `anonymous:` namespace is
rejected both at authoring (`RUNNER_BINDING_CONFLICT` from `step()`) and at
execution admission (a hand-crafted AST claiming an `anonymous:` binding
fails with `RUNNER_BINDING_CONFLICT` before any runner executes). What
remains is caller-owned: the pre-import guarantee is that realm forgery
cannot mint, alter, or collide an executable identity, while the caller owns
keeping each explicit binding pointed at one behavior; module-loader/preload
interception, which could rewrite the package itself, is outside the threat
model.

```ts
// previously anonymous (provably stateless), now requires a binding
step("ok", {
  runnerBinding: "my-module:ok:v1",
  run: (runtime, input) => input ?? "fallback",
});

// member access (including taskRuntime use) requires an explicit binding
step("ok2", {
  runnerBinding: "my-module:ok2:v1",
  run: (runtime) => runtime.effect("write", () => "ok"),
});

// capturing callbacks were already explicit-only
step("work", {
  runnerBinding: "my-module:work:v1",
  run: () => { counters.push("work"); return "done"; },
});
```

The explicit `runnerBinding` is canonical AST data, so it flows into the
replay identity; the caller owns keeping it stable across processes and
versions and pointing it at one executable.

A binding is valid only as a NON-EMPTY string, and validity is enforced at
runtime (TypeScript types are caller-erasable). `runnerBinding: ""` — which
previously counted as "explicit" while truthiness spreads dropped it from the
canonical AST, leaving a registered executable with no canonical name — now
throws `RUNNER_BINDING_INVALID` at `step()`, as do whitespace-only and
non-string bindings, whether or not a callback is attached. `runScenario`
admission enforces the same predicate on plain-data ASTs: a step whose
executable is reachable (out-of-band `stepRunners` or builder-attached)
without a valid canonical binding fails with `RUNNER_BINDING_REQUIRED`, and a
present-but-invalid binding fails with `RUNNER_BINDING_INVALID` even with no
runner in sight — no identity is minted and no callback executes.
