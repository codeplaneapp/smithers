# Bounded owner correction

`correction.ts` is an opt-in repository recipe. It exports `CorrectPlan`,
`correctionLayers`, `SelectRepair`, and its private `CorrectionResult` schema.
It does not change `coding/RunPlan`, register a gateway capability, or create a
coding ledger. A host must explicitly compose it with the existing coding,
agent, native JJ, executable catalog and check layers before advertising it.

```ts
const result = yield* CorrectPlan.execute({ plan, maxRounds: 3 })
```

`maxRounds` counts validation passes, including the first implementation pass,
and must be between one and eight. One means implement and assess once, with no
repair. A validated result stops immediately. At the bound, unresolved findings
return `changes-requested`; they never become approval, vibed status or delivery.
Each round uses the existing durable trampoline. Each pass is a recorded child
execution, and completed agent/JJ/check steps replay through the normal engine.
There is no process-local retry loop or parallel correction writer.

The first pass calls `ImplementPlan` unchanged. Once all of that pass's slow
checks settle, the recipe chooses the earliest owning Change among its findings.
An ordinary `AgentAction` selects one existing atom in that Change and a focused
repair intent. It uses the existing `coding/implement` seat and asks for no tool
calls. The deployment owns the model's actual capability envelope; the prompt
is not an authorization boundary. Enforcing a narrower planning role remains
a host-integration task; this recipe does not claim that the current
`coding/implement` seat prevents mutation. A deterministic action rejects an unknown or
foreign atom before implementation. The normal implementation delegate edits
that atom in place, preserving its JJ change ID.

Before editing, the recipe re-reads the base and every known atom and refuses
changed code, missing IDs, ambiguity or conflicts. After editing, it re-reads
all IDs, verifies the selected atom and unchanged prefix, and requires one linear
native parent chain. JJ performs descendant restacking. The workflow restores
the working copy to the known mythical tip with a prepared native request; it
never substitutes an arbitrary current head. A concurrent native operation after
the repair's completed receipt refuses that restoration instead of refreshing
its fence silently. The host still owns exclusive coordination of editing work.

Each history observation includes its causal phase and preceding mutation receipt
in the ordinary action input. This distinguishes the before-edit, after-edit and
restored-tip reads during durable replay without adding a second cache.

Operation IDs describe a native read view. A newer read operation alone does
not invalidate an unchanged prefix: its change, commit, tree and parent commit
identities must still match, and its original complete implementation and
receipts are retained. A rewritten suffix receives fresh native revision
references. Only an exactly unchanged reconstructed implementation retains its
old receipts. Otherwise the existing `RunCheck` delegates measure that revision
again, and the normal input digest prevents stale results from validating it.
The recipe does not copy a passed flag onto a rewritten tree.

Fast checks still gate the next rechecked Change. Slow checks overlap subsequent
rechecks. Final assessment uses the existing policy, including the source commit
and earlier-owner finding validation. This version starts correction only after
the preceding pass's slow branches settle. It does not yet interrupt ongoing
forward implementation immediately when an early slow result arrives.

`CorrectionResult` is a private workflow output, not a new store:

```ts
type CorrectionResult = {
  status: "validated" | "changes-requested" | "blocked"
  rounds: number
  result: Result | null
  blocked: { executionId: string; message: string } | null
}
```

An execution failure, including a required fast failure, returns `blocked` and
the failed pass's native execution ID and a bounded error summary. Its actual check and failure evidence
remains in that child's existing journal and attempt store. The last complete
assessment is included when one exists. The recipe never fabricates a partial
validated result after a fast failure or advances to another repair round.
The parent flow completes with this typed blocked outcome while the failed child
retains its native failed status. Consumers must inspect `CorrectionResult.status`: a
completed orchestration run alone does not mean the code is validated or deliverable.
Cancellation remains cancellation rather than blocked evidence.

The acceptance fixture uses real JJ, the existing Plue adapter, immutable source
exports, real check processes and SQLite. Planner/editor behavior and earlier
owner classification are scripted, so it proves correction, gates and replay,
not the quality of a live model's repair choice or a deployed host.

Memory gathering and clarification, disposable POC feedback, history cleanup,
vibing, append-to-main and optional delivery/canary stages remain separate
composition work. The underlying memory flows, HumanTask, artifacts, Plue native
operations and landing service already provide relevant primitives; this recipe
does not replace those facilities.
