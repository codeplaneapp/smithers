# Prompt planning from repository evidence

`PreparePlan` is a private repository recipe composed from ordinary `Flow`,
`Action`, `AgentAction`, and `HumanTask`. It returns the existing coding `Plan`;
it does not execute that plan or create another storage service. The supplied
runtime persists its observations, model results, question, answer, and final
plan in the existing flow journal and database.

```ts
import { PreparePlan } from "./planning.ts"

const prepare = PreparePlan.execute({
  prompt: "Add a query API using the current storage layer.",
  feedback: ""
})
// Supply the configured Effect host, then run this Effect. A material question
// parks durably and is answered through the existing HumanTask interface.
```

This is a new **private workflow entry**, not a public Smithers package API.
The deployment provides `memoryLayer(options)`, `planningPolicy`, both model
action layers, `HumanTask.layer`, and `Interpreter.layer(PreparePlan)` through
the runtime's existing action registration. `coding/plan` is a logical model
seat which the deployment must resolve using its authorized provider route.
The model prompts request planning only; they are not an authorization boundary.
Deployment capability narrowing is required before exposing these actions on a
host that also admits mutation tools.

## Gather, clarify, draft, verify

The default `GatherContext` implementation snapshots current bytes through the
configured native `Jj` service, preserving the same JJ change. It asks Plue for
a bounded, resolved linear native history, then uses the wiki's owning verifier
to check source freshness, immutable publication integrity, and recorded
semantic review. Missing or stale documentation refuses planning; this recipe
does not yet regenerate it automatically.

The existing memory keyword scorer ranks complete current-behavior and intent
pages against the request and saved feedback. It retains complete pages within
a byte budget, with source identities and explicit current/intent labels.
Repository content is evidence for the planning model, never authority to
change the host's instructions. The provider context contains no private Ops
material: inputs must come from the configured public engineering wiki catalog.

`ReviewRequest` explains material constraints and either proceeds or emits one
bundled clarification. A nonempty question calls the existing durable
`HumanTask` with kind `ask`. A restarted host can answer that same token and
resume without asking the model to reconstruct its earlier reasoning.

`DraftPlan` chooses native atoms and predicts reads and writes. It selects
implementation/check names only from measured host catalog entries. Its
rationale and the request review remain separate recorded outputs, available
for the UI's explanation and detailed execution views.

After any human wait and model draft, `VerifyContext` captures current bytes
again, verifies every gathered native identity and parent chain, and rechecks
wiki freshness. A code change while planning refuses the result as stale.
`FinalizePlan` binds choices to the original verified executable digests,
memory identity, and actual native base. Downstream implementation and checks
retain their own existing revision and executable fences.

## Internal data and native adapter contract

The new `PlanningContext` is durable action input/output, not a database table:

- `head` and oldest-to-newest `history` contain native change, commit, tree,
  parent, and operation IDs, plus native descriptions.
- `memory` contains complete selected wiki pages, labeled `current` or `intent`,
  with the publication source revision and each page's input digest.
- `implementation`, `implementationDigest`, and `checks` identify verified
  catalog definitions. The model cannot supply replacement digests.
- `memoryRevision` is a canonical digest of this measured evidence.

The existing private Plue read request accepts optional `historyLimit: 1..100`.
Only requests supplying it receive `history`; legacy read payloads and results
retain their shape. No atomic ID is minted: a planned existing atom uses its
full native JJ change ID, and a new atom uses `null` until JJ creates it.

The history window must end at the captured head and contain one parent per
atom. An append uses the current head as base. An amendment chooses a visible
earlier base and retains every existing descendant in native order before
adding new atoms. Missing context, omitted/reordered descendants, duplicate
ownership, unknown checks, and paths escaping the repository or entering native
metadata are refused. Each Change needs a required fast and required slow
check. This pass does not yet insert new atoms between existing ones or reorder
history. The model is instructed to use small emoji conventional commits;
final history cleanup is a separate later lifecycle step.

`feedback` is bounded text intended for saved disposable POC findings. Passing
text does not assert that a POC ran, and this workflow does not produce a POC.
The host owns the evidence source for that second pass.

## Platform and verification

The recipe uses injected Effect filesystem, path, process, native JJ, catalog,
and runtime services. It opens no database or Node sidecar. The same flow runs
with Node or Bun platform and SQLite layers.

`coding-planning.test.ts` verifies the native suffix/ownership/catalog policy
and runs real JJ, verified wiki artifact checks, and durable SQLite waits on
both platforms. It closes and reopens the host, answers the stored question,
checks terminal replay, and refuses source changed during clarification and
stale wiki dependencies. Model decisions and semantic citations are scripted
in this integration fixture; it is not a live-provider evaluation.
