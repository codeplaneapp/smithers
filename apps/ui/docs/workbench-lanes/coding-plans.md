# Predicted coding Changes in a run

Updated 2026-09-09. Owner: `apps/ui`. Recipe contract: `flows/coding/schema.ts`.

The existing run card shows a compact ordered list of predicted Changes before
execution. Selecting a Change reveals its atomic commit messages, existing native
JJ change IDs where known, intent, predicted reads/writes, and planned fast, slow
and delivery checks. These are predictions, not execution or passing-check claims.
The ordinary turn narrative and recorded debugger detail remain in the same card.

The current shell owns conversation visibility: Command-K / Control-K opens it,
Escape dismisses it, and chat is hidden by default. See `../ONBOARDING.md`.
This change does not introduce another dashboard or change the shell's policy.

## Existing app API extension: structured flow input

`flow.run` now accepts an optional JSON object after its existing arguments:

```text
/flow.run check will/repo {"target":"//ui:typecheck"}
/flow.run coding will/repo {"plan":{...}}
```

The second line shows the envelope, not a complete executable plan. Its `plan`
must satisfy the repository recipe's `Plan` schema and validation rules.
Existing `flow.run <name>` and `flow.run <name> <owner/repo>` invocations still
launch with `{}`. Omitting the repository retains the existing repository
selection rules. Nested values and whitespace inside JSON strings are preserved;
arrays, scalar inputs, malformed JSON, and text after the object are refused.

The app flow's input is now
`{name: string, repo?: string, input?: Record<string, Json>}`. The existing form
derives an Input JSON field from that schema. A malformed object remains on the
form with its parse error and cannot launch until corrected. This also fixes the
form's existing text conversion for an object value: it displays JSON instead of
`[object Object]`. No new field kind or form framework was added.
Form edits replace the existing card payload so clearing an optional parse error
persists correctly; the form's authorization continuation remains unchanged.

The controller forwards the object through the existing workflow launch:

```ts
await controller.runWorkflow("coding", "will/repo", { plan })
```

This is an extension to an existing app controller method, not a public package
API. Provisioning, launch capability checks, gateway Plan/Run procedures,
idempotency, and the run card all use their established paths. The registered
repository descriptor is `coding`; its internal delegate tag `coding/RunPlan`
is not the name to pass to `flow.run`.

## New app flow and internal state

```text
/runs.coding.select RUN_ID CHANGE_ID
```

The typed input is `{runId: string, changeId: string}`. Slash, button and agent
doors use the same actor-tagged dispatcher. Selecting the current Change again
collapses it. A missing Change or run is refused; missing input uses the existing
schema-derived form. Native button semantics provide Tab, Enter and Space
operation with a visible focus outline.

The only new persisted presentation field is optional
`run-trace.payload.codingChangeId`. The plan itself remains in the existing
recorded `input.plan`; reopening a known run retains that original launch input
and selection. The renderer imports the recipe's actual Effect `Plan` schema and
validation function. It does not copy the contract into another Zod schema or
create a plan table. Missing or invalid recorded input produces no invented plan.

## Evidence boundary

At this stage, the outline describes the recorded launch input only. It does
not claim that the native workspace has been mutated, that a check has passed,
or that a Change is vibed or shipped. Planned null atomic IDs remain unassigned;
the UI does not mint substitute change identities.

The existing gateway reads the control journal, while durable engine records
currently live in the engine journal. Host composition must expose actual
recorded implementation/check evidence before this view can show those outcomes.
No agent turns, receipt statuses, or synthetic engine events are manufactured by
the browser. Native coding operations remain in the durable host. The workspace
reporter's `@` is not treated as a complete mythical-history mirror.

## Design references and validation

[Graphite's stack review UI](https://graphite.com/docs/review-pull-requests)
keeps stack navigation beside the change being reviewed and provides keyboard
navigation. Here the compact Change list retains that context while one selected
Change exposes its predicted atoms and file ownership. The card's existing
turn/timeline inspection supplies recorded execution detail separately.

Focused tests cover typed launch and JSON form correction, native plan-schema
validation, actor-tagged selection, reload/reopen retention, and absence of
invented outcomes. The Chromium test opens Command-K, launches a synthetic plan
through the real flow/controller path, traverses controls with Tab, expands and
collapses with Enter/Space, restores state after reload, and maximizes the same
component. The backend is a fixture in that browser test; it is not a live coding
canary.

Browser rendering is optimistic. The reload checks wait for the existing verbose
command-settlement trace before reloading OPFS; reloading an in-flight write can
restore the preceding selection. This slice does not add a global saved-state
indicator or change the app's persistence scheduling.
