# A prompt through the existing native host

`coding/request` is a private repository declaration, backed by the existing
registered `coding/RunRequest` delegate and `coding/Request` flow. It accepts
`{ prompt, feedback?, maxRounds? }`; the correction limit defaults to three and
admits one through eight passes. The first implementation counts as a pass.

```ts
import { Request } from "./request.ts"

// In the configured Effect runtime, using its existing journal and database:
const result = yield* Request.execute({
  prompt: "Add the query using the current storage layer.",
  maxRounds: 3
})
// result.plan: the measured, prepared Plan
// result.outcome.status: validated | changes-requested | blocked
```

This is a new private flow entry and internal result shape, not a new public
Smithers package API. The gateway continues to use its existing plan, approval,
run and watch operations. There is no additional endpoint, database, queue or
executor. The host advertises `coding-request/v1` only when its operator has
provided the owning planning configuration and its verified declaration is
available in the catalog.

The current composition prepares a plan from verified repository memory,
asks any material question through the existing durable HumanTask, admits its
observed native source, and calls the bounded correction workflow. Each stage
and its output belong to ordinary native execution records. The correction
result's product status is distinct from the surrounding engine's completion:
`blocked` carries the actual failed execution ID and does not assert validation.

`Options.planning` configures the existing memory action with the repository's
public engineering wiki pages and registered implementation/check names.
`planningModel` optionally selects its existing authorized provider route;
otherwise planning uses `implementationModel`. These are private operator
options. The prompt cannot select a different source directory, reviewer,
check executable, model credential or implementation digest.

The host builds its verified executable catalog before providing that exact
catalog to the planning and coding action layers. Declared source bytes are
loaded using the host filesystem during startup; subsequent agent tools use
the existing guarded filesystem and native file eligibility rules. The private
native registration type exposes the injected JJ and SQL services already
present in that runtime; it constructs neither another service nor connection.

Planning, owner-repair selection and review actions are composed with the
captured-evidence authority helper. They retain model routing, budget,
steering and observation, while receiving no tool authority. The existing
agent `unmovedCap: 0` option avoids demanding a code edit from a planning
answer. Actual implementation continues through native JJ, guarded agent
tools, fast gates and asynchronous immutable-source slow checks.

The configured-host acceptance fixture drives the actual gateway host's
Control API with scripted models, real QuickJS cells, Plue JJ, SQLite and
process checks. It asserts that planning cannot write, implementation can use
Write/Edit/ApplyPatch, ignored files are refused, and the persisted request
result identifies both the original observed source and the validated native
atom. It runs with both Node and Bun platform services. Scripted output is not
a live-provider quality evaluation.

Upstream wiki regeneration and disposable POC/replanning are separate private
flows being composed into this request entry. This initial integration does
not yet claim that they ran, that a plan was vibed, or that code shipped.
