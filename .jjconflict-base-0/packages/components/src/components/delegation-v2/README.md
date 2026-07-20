# Trellis (delegation protocol v2)

Trellis is the experimental recursive successor to `DelegationChain`.
Sol/Fable author a strict JSON workflow fragment; Smithers validates it, mounts
it inline in the current run, settles every leaf into one outcome contract, and
invokes the author again with the resulting evidence.

The public product name is **Trellis**. `delegation-v2` remains the internal
protocol/module name so the code is searchable by architecture version.

## Phase A contract

- Authored IR: `agent | sequence | parallel`.
- Author roles: Sol and Fable.
- Worker roles: Terra and Luna.
- Return envelopes: authors may return `subworkflow | complete | blocked`;
  workers may return only `complete | blocked`.
- Execution: inline in one run, with every accepted generation kept mounted.
- Identity: immutable physical IDs derived from author lineage, generation,
  normalized program digest, logical ID, and phase.
- Concurrency: the launch must pin `RunOptions.maxConcurrency`; authored
  parallel widths are only local caps and cannot exceed the root cap.
- Fuel: `maxTotalAuthorTurns` is partitioned into immutable, non-refundable
  subtree budgets. Every Sol/Fable author or semantic-repair call consumes one;
  hidden format repair is disabled with `maxSchemaRetries={0}`.
- Settlement: every terminal claim is checked against its trusted assignment,
  exact acceptance IDs, output contract, and proof references before a parent
  can consume it.
- Exceptional Sol/Fable `execute` nodes are disabled unless the caller supplies
  `criticalExecutionPolicy`. A structured model request must fit its category,
  relative-path, and expected-line ceilings, name an independent reviewer, and
  join that review into a declared output. The compiler binds the resulting
  grant to the exact invocation, program digest, logical node, role, work, and
  reviewer's role and canonical outcome node.
  Independence requires a different role whose configured AgentLike/failover
  chain does not overlap the executor's by object identity or explicit agent
  ID; a second graph node alone is not an independent actor.
- Author transport captures malformed but bounded JSON so schema-invalid IR can
  reach deterministic validation. One semantic repair may touch only diagnosed
  fragments and necessarily affected references; it cannot replace valid
  topology or continuation state.

This phase supports direct delegation, pipelines, fan-out/fan-in, panels,
research/POC waves, and adaptive review/optimization through author
continuations.

## Deliberately not claimed yet

- The existing `Subflow mode="inline"` is a no-op and is not used.
- Child runs do not share a global admission pool and are not authorable.
- The nonblocking `ask_question` broker is specified but not yet wired; prompts
  must receive `questionToolAvailable: false` until it is.
- Nested Smithers concurrency scopes are nearest-only; the root run cap is the
  hard aggregate.
- Current Aspects are not hierarchical USD/per-task budget enforcement.
- `Task.allowTools` is not an authority boundary for every adapter.
- Prompt rules cannot prevent a shell-capable agent from invoking an ambient
  command. Phase A therefore does not claim adapter-level question/tool
  isolation; use sandboxed role agents and an explicit `semanticRevision` when
  their policy changes.
- `criticalExecutionPolicy` is a trusted admission ceiling, not a filesystem
  sandbox or measured-diff guarantee in Phase A. Its line bound is per admitted
  execution. Real path/line enforcement requires adapter-owned write tools or a
  worktree diff-and-rollback gate.
- Session `fork` improves continuity, but the explicit persisted continuation
  packet remains the source of truth.

Branches, loops, dynamic foreach, audited macros, task-scoped questions,
hierarchical budgets, portable sessions, and child-run leases are promotion
milestones described in `.smithers/specs/dynamic-delegation-v2.md`.
