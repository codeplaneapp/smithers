# Coding progression

This repository recipe expresses the coding policy as ordinary `Flow.make`,
`Action.make`, and Effect layers. The existing flows runtime stores the plan,
action outcomes, child execution relationships, and replay state through its
injected database. There is no coding database, queue, lease, or event store.

`native.ts` is the private Effect adapter to the Plue-owned program installed by
the existing sandbox head-reporter provisioning. The host merges `nativeActions`
into its current action table and provides
`nativeLayer({ repositoryPath: executionRoot })` through its existing injected
`ChildProcessSpawner`. Both Node and Bun run that composition. The TypeScript
file contains no JJ command implementation, HTTP credential, or native receipt
store. A host without the installed adapter fails clearly when it calls it.

The new **internal** `NativeCoding` Effect service exposes `read(changeIds?)` and
`apply(operation)`; ordinary `ReadNative` and `ApplyNative` actions record those
requests/results in the existing flow. For example, after reading an exact
resolved revision in a recorded planning step:

```ts
ApplyNative.call({ operation: {
  operation: "create",
  requestId: requestIdFor(executionId, "create/database"),
  expectedOperationId: parent.operationId,
  target: parent,
  description: "✨ feat(database): add the schema"
}})
```

`requestIdFor` derives a stable invocation UUID from the existing execution ID
and action key. It never identifies an atom. On an unknown outcome, replay the
**original** request, including its exact parent and operation IDs; rereading
`@` to manufacture a new request could duplicate an already committed mutation.
Plue reconstructs native receipts at their historical operation view even after
later edits. A conflicted revision has native `treeTerms`, no `treeId`, and must
not pass fast acceptance. `unchanged` is not a durable mutation receipt.

Local accepted results carry `provenance: "pending"`: the existing head reporter
asynchronously projects native operation metadata into Plue's `jj_operations`.
This service cannot assert that the cloud acknowledged it or that all rewritten
descendants were published. The publisher exports only `@`; after an older edit
the workflow must explicitly `edit` back to its known mythical tip. The installed
identity names the effective workspace execution principal. The initiating user
of a shared run remains separately attributed by the control journal, and is not
overridden by arbitrary flow input.

`ImplementPlan` predicts one linear sequence of product Changes. A Change groups
native JJ changes; an atom's `changeId` is the JJ ID and remains stable when its
commit is rewritten. A planned new atom has `changeId: null` until JJ creates it.
`Revision` records JJ change, commit, tree, operation, and parent commit IDs.
The product Change's `id` is a grouping label, not another identity for an atom.

Every Change has at least one required fast and slow check. Fast receipts gate
the next implementation. Slow checks run alongside subsequent Changes. Required
delivery checks are deferred to the later vibing/landing workflow. Implementation
evidence must form a single parent chain from the exact supplied parent, retain
existing atom identities, and end at the reported head. Check receipts identify
the target, JJ commit/tree and measured input digest; a receipt for a previous
revision cannot unlock progression. A late finding names its owning Change and
the actual reviewed commit, so a downstream discovery can request an earlier fix.

`Check.flow` and `Change.implementation` name the host's existing registered
project flows. Those flows perform the actual native JJ and build operations and
return the schemas in `schema.ts`. Plans pin `flowDigest` and
`implementationDigest` from the registry's existing `Descriptor.executionDigest`
before execution. The catalog refuses a changed definition, and replanning starts
a new execution. Reopening a completed execution shows its original planned
definition and receipts; it does not silently substitute current code.

`Receipt.inputDigest` must equal `checkInputDigest(implementation, check)`, the
existing canonical SHA-256 digest of the exact delegated inputs including the
pinned definition. A native build's additional artifact/environment evidence
belongs in `evidence`; this fingerprint alone is not proof that a test ran.
The catalog adapter derives child execution
identity from the full payload and the registry's verified executable digest.
The ordinary runtime attaches the ambient parent and recovers completed children
after restart. It refuses unavailable or unverified project flows.

## Host composition

`registration.ts` is private repository configuration, not a new package API.
Register `RunPlan` as a delegate when constructing the host's existing executable
catalog, provide that catalog to `registration`, and pass the registration to the
host runtime. The discovered `flow.ts` declares `coding/RunPlan`; its invocation
uses the registry's existing envelope containing `input: { plan }`. The native
flow is also directly callable from another registered flow:

```ts
import { ImplementPlan } from "./workflow.ts"

// Inside an Effect scope with the deployment's runtime and action layers.
const result = yield* ImplementPlan.execute({ plan })
```

The recipe and catalog adapter import no Node or Bun APIs. Deployments inject
their platform through `@smthrs/flows/Runtime`, `NodeRuntime`, or `BunRuntime`.
The Node-specific imports in `test/coding.test.ts` only construct test fixtures.
Do not introduce a Node sidecar as a requirement for a Bun desktop host.

## Current boundary

This is a validated implementation pass, not the complete coding product. Its
result is `validated` or `changes-requested`. The pass does not yet apply
corrections, restack earlier revisions, invalidate downstream builds, clean
history, mark work vibed, append to main, or ship. Those operations need the native
Plue JJ/build delegates and subsequent ordinary workflow stages. Nor does a
receipt schema prove that an arbitrary delegate performed a real test: deployment
adapters must measure their native results rather than trust agent assertions.

Ten integration tests exercise a real native flows runtime with SQLite and JJ
fixtures: fast failure, stale receipt, wrong parent, earlier-owner feedback,
overlapping slow review, preflight refusal, and registered child replay across a
host restart. Review regressions also reject changed executable definitions,
different check inputs, inconsistent complete revision fields, and atom identities
reused by nonadjacent Changes. Implementation/check fixtures are scripted; these tests establish
graph and durability behavior, not live coding capability.
