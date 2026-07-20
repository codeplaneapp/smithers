# Smithers Effect Combinator API — Counter-Proposal

In response to [andrueandersoncs's combinator proposal](https://gist.github.com/andrueandersoncs/e4f4e87e2f2c5ab4df6f8879163ad075).
Adopts the structural ideas; rejects the dual-API framing and the input duplication.

**Status:** Implemented. See `packages/engine/src/effect/builder.js` and
`packages/engine/tests/effect-builder.test.js`. User-facing docs live in
`docs/effect/overview.mdx`.

## The change

Today:

```ts
Smithers.createWorkflow({ name, input: inputSchema })
  .build(($) => {
    const a = $.step("a", { ... });
    const b = $.step("b", { needs: { a }, ... });
    return $.sequence(a, b);
  });
```

Replaced with:

```ts
const G = Smithers.workflow({ name, input: inputSchema });

const a = G.step("a", { ... });
const b = G.step("b", { needs: { a }, ... });

export default G.from(G.sequence(a, b));
```

The workflow handle `G` is the typed namespace. Constructors hang off it directly.
The input schema is declared exactly once. Step values are ordinary exportable
values, not closures over a builder token.

## What's removed

- **`.build(($) => ...)`**. No transition period, no compatibility shim. Existing
  workflows are migrated as part of the change. The original proposal kept both
  APIs; we don't.
- **`createComponent`**. Multi-mount reuse becomes `G.scope(instanceId, fragment)`.
  No separate definition kind, no `buildWithPrefix` machinery.
- **The original proposal's `Graph` namespace and `Graph.withInput` factory**.
  The workflow handle already serves that role. Declaring the input schema twice
  (once on `Graph.withInput`, once on `createWorkflow`) was a bug in the proposal.

## What's added

Methods on the workflow handle:

| Method | Purpose |
| --- | --- |
| `G.step(id, options)` | Durable task. |
| `G.approval(id, options)` | Durable approval gate. |
| `G.sequence(...nodes)` | Run children in order; return last result. |
| `G.parallel(...nodes, opts?)` | Run children concurrently; return tuple. |
| `G.match(source, cases)` | Branch on a step's runtime output (both branches statically known). |
| `G.branch(condition, cases)` | Branch on arbitrary `needs` ctx. |
| `G.loop(options)` | Repeat a fragment until predicate. |
| `G.worktree(options)` | Wrap children in a git worktree. |
| `G.scope(instanceId, fragment)` | Mount a fragment under a durable ID prefix. |
| `G.from(node)` | Finalize the workflow definition. |

These cover the full current `BuilderNode` union (`step`, `approval`, `sequence`,
`parallel`, `match`, `branch`, `loop`, `worktree`) plus `scope` for reuse.

Variadic over array for `sequence` and `parallel`. TypeScript infers tuple types
from variadic params naturally (no `as const` needed for tuple-shaped results),
and it matches the existing internal `BuilderApi` shape. Generated workflows
that have an array `xs: BuilderNode[]` use `G.sequence(...xs)`.

Every graph value supports `.pipe()` from V1, even though no pipeable
combinators ship initially. This is idiomatic Effect, costs ~nothing, and means
adding pipeable forms later (`G.scoped(id)`, etc.) doesn't break the API.

## What's deferred

- `zipLeft`, `zipRight`, `annotate`, `empty`. No real call site asks for these.
  Add when one does.
- The f-algebra (`WorkflowF<R>`, `Algebra<R>`, public `Graph.fold`). Stays an
  internal implementation detail.
- Tooling helpers (`collectStepIds`, `toMermaid`, `validate`). Add when there's
  a consumer.
- A workflow-independent `Smithers.fragment(inputSchema)` factory for fragments
  that need to live across workflows. Open question — see below.

## `match` is not Effect's `Match`

Effect's `Match` module is runtime value pattern matching. `G.match` is graph
topology selection driven by a step's runtime output: both branches must be
statically known so durable IDs stay stable across resume. Worth a one-line note
in the docs to head off confusion. We are not replacing it with an Effect
built-in; the constraint is structural.

## Effect.ts alignment

We adopt Effect conventions where they fit, and decline where they would force
semantic changes outside the scope of this proposal:

- **Adopted**: `.pipe()` on graph values; `Effect.gen` and `Effect`-returning
  bodies inside `run`; Schema-driven input/output; explicit, statically-known
  topology (matching Effect's preference for declarative composition).
- **Declined for V1**: full data-first/data-last duality on every combinator —
  several of ours take two arguments (`match(source, cases)`) and don't dual
  cleanly; pipeable forms ship per-combinator when they earn it.
- **Out of scope**: replacing the retry options object with an Effect
  `Schedule`; typing step error channels; generator-style graph construction
  (`Graph.gen(function*() { ... })`). These are larger semantic changes; this
  proposal is about authoring ergonomics.
- **Rejected**: a monadic `flatMap` over runtime step outputs. Graph topology
  must be statically knowable for durable IDs and resume to work. The original
  proposal also rejects this; we agree.

## Reuse story

Static reuse: a graph value, exported.

```ts
const reviewShard = G.sequence(read, summarize);
```

Parameterized reuse: a function returning a graph value.

```ts
const makeReviewShard = (path: string) =>
  G.sequence(
    G.step("read", { run: () => readDiff(path) }),
    G.step("summarize", { needs: { read }, ... }),
  );
```

Multi-mount: `G.scope` applies a durable ID prefix.

```ts
G.parallel([
  G.scope("api", makeReviewShard("packages/api")),
  G.scope("web", makeReviewShard("apps/web")),
]);
```

This is the entire reuse surface. `createComponent` was solving exactly one
problem — durable ID prefixing — and `G.scope` solves it as a first-class combinator.

## Memoization

The compiler must memoize step expressions per scope. Cache key is
`(prefix, expr)`. Concrete invariants, with tests:

- Same step value referenced as both a child and a `needs` source → one
  `BuilderStepHandle`.
- Same fragment mounted under two scopes → two handle sets, distinct prefixed IDs.
- Same step appearing inside and outside a scope → distinct handles.

These tests ship with the implementation, not after. Memoization is the failure
mode that silently breaks resume.

## Compilation

`G.from(graph)` compiles the graph expression tree to a `BuilderNode` tree using
the existing internal builder. The runtime, persistence model, scheduler, and
SQLite tables are unchanged. Step IDs remain `prefix.localId` strings, allocated
deterministically at compile time.

`G.step` does not eagerly allocate a `BuilderStepHandle` — it stores a graph
expression. Allocation happens during `G.from(...)` with the active scope prefix.
This is the only way `G.scope` can apply prefixes correctly across reuse.

## JSX coexistence

The JSX surface (`createSmithers`) is unchanged. Both surfaces still compile to
`BuilderNode` and run through `renderFrame`. We go from three authoring surfaces
(JSX + Effect callback + retired TOON) to two (JSX + Effect combinator). Net
simplification.

## Migration

Mechanical:

1. Pull step and approval declarations out of the `.build` callback.
2. Replace `$.x` with `G.x`, where `G = Smithers.createWorkflow(opts)`.
3. Replace the trailing `return $.sequence(...)` with
   `export default G.from(G.sequence(...))`.
4. Replace `createComponent(name).build(($, params) => ...)` with a function
   returning a graph fragment, mounted with `G.scope(instanceId, fragment(params))`.

A codemod handles the bulk of (1)–(3). (4) needs a one-time human pass per
component but the rewrite is local and obvious.

## Cross-workflow fragments

For fragments that need to live across workflows with different (but
schema-compatible) inputs, `Smithers.fragment(inputSchema)` returns a
workflow-less factory:

```ts
const F = Smithers.fragment(diffInputSchema);

const readDiff = F.step("read", { run: ({input}) => readDiff(input.path) });
const summarize = F.step("summarize", { needs: { readDiff }, ... });

export const reviewShard = F.sequence(readDiff, summarize);
```

The fragment is mountable into any workflow `G` whose input type extends the
fragment's input schema:

```ts
G.scope("api", reviewShard);
```

`Smithers.fragment` exposes the same constructors as a workflow handle (`step`,
`approval`, `sequence`, `parallel`, `match`, `branch`, `loop`, `worktree`,
`scope`) but no `from` — fragments are values, not workflows. Compilation
happens when they're mounted into a real workflow.

## Recommendation

Ship this as a single replacement of the Effect callback API. One PR:

- Add the new surface on the workflow handle.
- Wire `G.from` into the existing builder/runtime path.
- Codemod existing internal workflows.
- Delete `.build(($) => ...)` and `createComponent`.
- Update docs (`docs/effect/`, `docs/llms-effect.txt`) to use the new API
  exclusively.

The runtime is untouched. The user-facing API gets shorter. The reuse story
collapses from two mechanisms to one.
