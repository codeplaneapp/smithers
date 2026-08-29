# Self-healing repair steps (issue #1500, section 3) and the zero-cache-hit finding

> **Written for Smithers 0.x.** This note is research from before the 1.0
> rewrite. It describes the JSX workflow runtime, its CLI, or its gateway, none
> of which exist in 1.0.0-rc.0. It is kept as history, not as guidance; see
> `docs/pages/migration/1.0.md` for what replaced each surface it names.

Status: design only. Nothing in this document is implemented. It builds on the
non-progress detection, failure classification, enriched run errors, and
resume affordances that shipped for asks 1, 2, 3, and 4 of
[#1500](https://github.com/smithersai/smithers/issues/1500).

## Why this is worth building

The reported incident ran a 56-task workflow for 5.6 days across 384 runs and
never completed. The operator hand-authored 31 one-off repair workflows: read
the failure, identify the artifact or contract that drifted, apply a targeted
mutation, resume. Every one of those repairs followed the same shape, and every
input to them was already in the run store.

Asks 1 to 4 make the failure *legible and bounded*: a livelocked node stops
after 3 identical failures instead of 84, the run error carries the real
payload, and the failure output names the checkpoint to resume from. What they
do not do is close the loop. A human still writes the mutation.

## What now exists to build on

| Piece | Where | What it gives the repair loop |
| --- | --- | --- |
| Error signature | `packages/scheduler/src/errorSignature.js` | A stable identity for "the same failure", so a repair round can refuse to re-repair a signature it already tried. |
| `stalled` terminal state | `packages/scheduler/src/TaskState.ts`, `makeWorkflowSession.js` | The trigger. A node that stalls is a deterministic failure by construction: it is exactly the case where regenerating cannot help and mutating the world might. |
| `NodeStalled` event | `packages/engine/src/failure-streak.js`, emitted from the agent, compute, and static task bridges | The durable hook a repair supervisor can subscribe to, carrying signature, streak, and payload. |
| Failure classification | `packages/scheduler/src/failureClassification.js` | Separates "precondition missing" (repairable by creating it) from "flaky" (repairable by retrying). |
| Enriched run error | `makeWorkflowSession.js` (`TASK_STALLED`, `SESSION_ERROR`) | The diagnose bundle's error half, already structured: `nodeId`, `attempts`, `identicalFailures`, `signature`, and the raw attempt error as `cause`. |
| Recovery pointer | `packages/engine/src/run-failure-recovery.js` | `details.recovery` names the run, last frame, last workspace checkpoint, and the resume and replay commands. This is the "apply and resume" half already resolved. |
| Approval primitive | `<Approval>`, `smithers approve` / `deny` | The gate, unchanged. |
| Scoped mutation boundary | none yet | The one genuinely missing mechanism. |

## Proposed design

### 1. Trigger

A repair round is offered when a node reaches a terminal failure state and the
workflow (or the run invocation) declares a repair policy. Two triggers, both
already emitted:

- `NodeStalled`: the strong case. The failure is deterministic by evidence.
- `NodeFailed` with a terminal classification (`ENOENT` precondition, size cap,
  `retryable: false` veto): the failure is deterministic by shape.

Ordinary retry exhaustion should *not* trigger repair by default. A task that
failed 20 different ways is not a contract drift, and paying an agent to guess
at it is the failure mode this whole issue is about.

Declaration shape, following the existing retry-policy precedent of putting
author-facing knobs on the task and letting the run override:

```tsx
<Task
  id="author-diagram"
  agent={author}
  repairPolicy={{
    on: ["stalled"],                       // default; add "terminal-failure" to widen
    maxRounds: 2,                          // hard cap per node, per run
    allowedPaths: ["artifacts/diagrams/**"], // required; no default
    approval: "gate",                      // "gate" | "auto" | "auto-if-scoped"
    agent: repairAgent,                    // defaults to the task's own agent
  }}
>
```

`maxRounds` and `allowedPaths` are mandatory-by-design: a repair loop without a
round cap is the livelock this issue opened against, one directory up.

### 2. Diagnose: the context bundle

Assembled entirely from durable rows, no new capture:

| Field | Source |
| --- | --- |
| `error` | Latest failed attempt's `errorJson`, including `details.errorSignature` and `details.identicalFailureStreak`. |
| `attempts` | `adapter.listAttempts(runId, nodeId, iteration)`, trimmed to state, error, and timing. Byte-identical repeats collapse to one entry plus a count. |
| `inputs` | The node's input rows and resolved dependency outputs, the same view `buildCacheContext` builds. |
| `checkpoint` | `details.recovery` from the run error: last frame and last workspace checkpoint. |
| `definition` | The rendered task descriptor plus the workflow source at `run.workflowPath`. |
| `priorRepairs` | Signatures already attempted this run, so the refuse-same-signature rule is enforceable and visible to the agent. |

Budget it explicitly. The failing prompt in the reported incident was 683 KB;
a diagnose bundle that inlines artifacts will breach the same cap that caused
the failure. Reference paths, do not inline contents.

### 3. Propose: the scoped mutation

The repair agent runs read-only over the workspace plus write access confined
to `allowedPaths`, and returns a structured proposal rather than editing in
place:

```ts
type RepairProposal = {
  rationale: string;
  signature: string;        // the failure this repair claims to address
  edits: Array<{ path: string; action: "write" | "delete"; contentRef: string }>;
  resumeFrom: "node" | "checkpoint";
};
```

The boundary check is the new mechanism, and it belongs in the platform, not in
each workflow. The incident log contains `repair modified forbidden paths:
<redacted>`, a guard the operator wrote by hand precisely because none existed.
Enforce it in two places:

1. **Statically**, on the proposal: every `edits[].path` must resolve inside
   `allowedPaths` after symlink resolution, and must stay inside the run's
   workspace root.
2. **Dynamically**, after apply: diff the workspace against the pre-repair
   snapshot and reject the round if anything outside the boundary moved. The
   snapshot already exists; this is a comparison, not new machinery.

A boundary breach is a terminal repair failure, never a retry. Re-prompting an
agent that just escaped its sandbox is not error handling.

### 4. Gate

`approval: "gate"` parks the run on the existing `<Approval>` primitive with
the proposal rendered as the approval payload: rationale, the file list, and
the diff. `smithers approve` and `deny` already drive it, and denial is a
terminal repair outcome for that signature.

`approval: "auto"` applies without a human. `auto-if-scoped` is the middle
setting worth having: auto-apply when every edit is inside `allowedPaths` and
the diff is under a size threshold, gate otherwise.

### 5. Apply and resume

Apply the edits, then resume from the last good checkpoint rather than from the
start, using the resume path `details.recovery` already names. Reset the
repaired node and its dependents the way `retry-task` does. This reuses
`smithers retry-task` and `replay` wholesale; the repair loop should call the
same code paths, not a parallel implementation.

Emit `RepairProposed`, `RepairApplied`, and `RepairRejected` events so a repair
round is as auditable as an attempt. The 0 time-travel audit entries in the
incident data are a warning: a recovery mechanism that leaves no trace does not
get trusted, and does not get used.

### 6. Bound it

- `maxRounds` per node per run, default 1.
- Refuse to repair a signature already repaired this run. Store attempted
  signatures on the run; the signature function is deterministic, so this is a
  set membership test.
- A repair round that produces a node failure with the *same* signature ends
  repair for that node permanently and fails the run with both the original
  failure and the repair attempt attached.
- Repair rounds are themselves subject to failure classification. A repair that
  hits `ENOENT` is not retried.

### Open questions

- Does a repair round belong in the run's own graph (a synthesized node) or
  outside it (a supervisor acting on the run)? In-graph makes the audit trail
  and resume path free but mutates the workflow shape mid-run, which
  interacts with hot reload and with continue-as-new.
- What happens on a stalled node inside a `ralph` loop, where iteration N+1
  may legitimately produce the same signature?
- Should a successful repair be promoted into a workflow-source suggestion?
  Most of the 31 hand-authored repairs were fixing the same class of contract
  drift, and the durable fix is in the workflow, not in the artifact.

## The zero cache hits finding (issue section 5)

Reported: 37 runs of one workflow, 860 attempts, `cached=0` on every one.

### Does attempt caching apply to agent task nodes at all

Yes. Agent tasks are cached on the same path as compute and static tasks, and
the key explicitly includes agent identity: `agentSig` (the agent id),
`toolsSig` (a hash of the capability registry), and `checkpointSig` (the
agent's checkpoint capabilities). Nothing excludes agent nodes.

### Why the hit rate was zero

Read `packages/engine/src/engine.js` around the `stepCacheEnabled` computation
and the `cacheBase` construction. Four independent reasons, in the order they
bite:

1. **Caching is opt-in and off by default.** `cacheEnabled` is
   `workflow.opts.cache ?? (<Workflow cache="true">)`, and per-task
   `stepCacheEnabled` is `(cacheEnabled || Boolean(desc.cachePolicy)) &&
   !hasActiveMemoryConfig`. A workflow that sets neither the workflow-level
   `cache` opt nor a per-task `cache={...}` policy never computes a cache key
   and never issues a lookup. This alone produces exactly the reported
   `cached=0 -> 860 attempts, cached=1 -> 0 attempts`: not a low hit rate, a
   feature that was never switched on.
2. **Any active memory config disables caching for that task**, unconditionally
   (`hasActiveMemoryConfig`). A long-horizon authoring workflow is the most
   likely kind to use memory banks, and doing so silently opts every such task
   out of the cache.
3. **The default cache key includes the workspace VCS pointer.** With no
   `cachePolicy`, `cacheBase` contains `jjPointer`, the working-copy pointer
   read at task start. In a workflow whose tasks write artifacts into the
   workspace, every upstream write moves the pointer, so each downstream task
   keys differently on every run even when its own inputs are unchanged. This
   is correct for correctness and fatal for hit rate in exactly this workflow
   shape.
4. **The default key also includes `nodeId`, `iteration`, and the full prompt
   text**, and (with a policy) `cacheScope` defaults to `workflow`. Prompt text
   assembled from upstream outputs changes whenever any upstream artifact
   changes, compounding reason 3.

### Is there a small safe fix

No, and it should not be forced. Each of the four causes is a deliberate
correctness choice, and flipping any of them by default trades silent
staleness for hit rate. Specifically:

- Turning caching on by default would serve stale outputs to workflows that
  never asked for caching, including side-effectful ones.
- Dropping `jjPointer` from the default key would return outputs computed
  against a different workspace state.
- Allowing caching alongside memory config would freeze a memory-conditioned
  generation under a key that does not mention the memory it read.

### Documented fix path

For a workflow with this shape, the working configuration is a per-task
`cache={{ by, scope, version }}` policy that keys on the task's *semantic*
inputs instead of the whole workspace:

```tsx
<Task
  id="author-section"
  agent={author}
  cache={{
    by: (ctx) => ({ section: ctx.input.sectionId, spec: ctx.deps.spec.hash }),
    scope: "global",     // survives across runs; "workflow" is the default
    version: "v6",       // manual invalidation handle
  }}
>
```

Declaring a `cache` policy replaces the default key body (see the
`desc.cachePolicy` branch of `cacheBase`): the volatile prompt text drops out
and `cache.by` supplies the semantic inputs, while `jjPointer` still
participates. Scope controls the identity that rides along
(`buildCacheScopeIdentity` in `packages/engine/src/cache-policy.js`): `global`
keys on the task key and output table alone, `workflow` adds the workflow
name, `run` adds the run id and so can never hit across restarts. The
`workflow` default would already have allowed cross-run hits here, but only if
a key ever matched.

Platform work worth doing, none of it required for #1500:

- **Emit a cache-disabled reason.** Today a task with caching off is
  indistinguishable from a task that missed. One event field naming the reason
  (`not-enabled`, `memory-config`, `by-threw`, `ttl-expired`, `key-mismatch`)
  turns "0 hits" from a mystery into a diagnosis. This is the cheapest item
  here and the one that would have answered this section without a code read.
- **Report cache statistics per run** in `smithers inspect` and `status`, so a
  zero hit rate is visible during the incident instead of in a post-mortem
  query.
- **Consider a `cache.by`-only key mode** that omits `jjPointer` for tasks the
  author declares workspace-independent. This is the principled version of
  reason 3, opt-in and explicit.
