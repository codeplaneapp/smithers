# Trellis UI and documentation plan

This is the moderated Sol plan, reduced to the buildable contract. Trellis is
an opt-in v2 surface beside the frozen `DelegationChain` v1 implementation.
Here, UI means the workflow-owned `smithers ui` application in `.smithers/ui`,
not a separate product web app or any POC application.

## Product boundary

- Public names: workflow `trellis`, component `Trellis`, UI `Smithers Trellis`.
- Fixed JSX stays the default for deterministic workflows. Trellis is preferred
  for broad tasks whose useful topology depends on evidence discovered at run
  time.
- Older v1 and Trellis histories are never rewritten or inferred into a newer
  protocol.
- Every displayed capability comes from persisted runtime truth. The UI does
  not infer semantics from package versions, physical ID parsing, or missing
  events.

## Phase A UI

Ship `.smithers/ui/trellis.tsx` with real Gateway data and progressive
disclosure:

1. A prompt-first launcher with root role, author-generation limit, graph
   limits, and a root concurrency selector. Launch passes the same value as
   workflow input and `launchRun.options.maxConcurrency`, pinning the hard
   run cap. Launcher controls are explicitly next-launch defaults.
2. An outcome-first overview: run state, root result, acceptance judgments,
   evidence, artifacts, blockage/runtime failure, current author generation,
   and selected-run concurrency/fuel limits read from persisted trusted task
   metadata. Per-invocation remaining fuel is labeled local rather than global.
3. A logical program view for `agent | sequence | parallel`, declared outputs,
   roles, work kinds, and accepted versus rejected generations.
4. A runtime view using `useGatewayRunTree`, with authored and physical
   structure clearly separated. A logical generation may compile to many
   physical tasks; retries are not generations.
5. A selected-node inspector that reads the exact physical node output through
   `useGatewayNodeOutput`. Raw JSON, hashes, IDs, and validation diagnostics are
   advanced details.
6. A timeline derived from durable run events. Rejected IR is labeled “never
   executed”; superseded generations remain visible and dimmed.

The initial UI may discover Trellis nodes by trusted labels and the current run
tree. It must not parse semantic fields from hashed physical IDs. A dedicated
`gateway-react/trellis` fold waits until trusted task metadata is transported
through the DevTools/Gateway snapshot contract.

### Phase A honesty

Display these as available:

- prompt-first launch;
- strict author/worker envelopes;
- accepted/rejected IR and one semantic repair;
- deterministic inline compilation;
- direct, pipeline, fan-out/fan-in, and nested-author execution;
- immutable generations and explicit continuation evidence;
- evidence-first canonical outcomes;
- pinned hard root concurrency and supported nearest local caps.
- caller-owned critical-execution admission, including policy/grant hashes and
  the independent review joined before continuation.

Display these as unavailable or deferred:

- nonblocking question answering;
- hierarchical USD/token/time budgets;
- all-ancestor compositional local concurrency;
- portable cross-provider sessions;
- snapshot-complete question/budget replay;
- arbitrary macros, child runs, graph editing, and in-place replanning.
- measured critical-work diffs and adapter-enforced path/line sandboxes; Phase A
  policy is admission metadata, not a write boundary.

## Read-model follow-up

Add `packages/gateway-react/src/trellis/` only after the runtime persists a
versioned manifest and trusted compiler metadata. Its pure fold should combine
historical events, the live run tree, and bounded exact node-output reads into:

```ts
type TrellisViewModel = {
  capabilities: TrellisCapabilities;
  invocations: InvocationView[];
  generations: GenerationView[];
  programs: ProgramView[];
  logicalNodes: LogicalNodeView[];
  physicalTasks: PhysicalTaskView[];
  outcomes: OutcomeView[];
  validation: ValidationView[];
  final?: FinalView;
  foldIssues: FoldIssue[];
};
```

The fold is append-only, permutation deterministic, duplicate tolerant, safe
under late join and run switching, and preserves malformed records as visible
issues rather than guessing.

## Later UI contracts

- Phase B: effective ancestor concurrency, retry/fuel consumption, portable
  continuation provenance, and typed capability denials.
- Phase C: a generic durable nonblocking question inbox and answer RPC; real
  hierarchical resource reservations; question/budget-aware timeline, fork,
  and replay.
- Phase D: registry-driven rendering for audited branch, loop, for-each,
  predicate, approval, sandbox, and macro adapters.

No answer button is shown until `listQuestions` and idempotent
`answerQuestion` Gateway RPCs exist. Existing blocking `ask_human`, approvals,
and signals are not repurposed.

## Documentation rollout

Phase A adds focused pages for the component, workflow, authoring model, one
simple prompt, and one adaptive review example. They must document:

- authority and tagged unions;
- authored IR versus compiled tasks;
- logical generations versus physical attempts;
- validation, one-shot repair, evidence, and supersession;
- exact props, registered outputs, limits, and root-cap launch requirements;
- an explicit Phase A–D capability matrix and security limitations.

Only after promotion should quickstarts, the create-workflow prompts, and the
agent operating playbook prefer Trellis for open-ended work. V1 documentation
gets a compatibility link, not a rewritten contract. Any `docs/` edit requires
`pnpm docs:llms`; generated LLM bundles are never hand-edited.

## Promotion gate

Promote Trellis only when real-runtime tests show that simple prompts collapse
to one or a few useful leaves, workers cannot grow graphs, invalid graphs never
mount, recursive fan-out stays under the pinned root cap, adversarial histories
terminate within fuel, continuation evidence reconstructs after resume, and
the UI can explain accepted, rejected, blocked, failed, and superseded work
without parsing physical IDs.
