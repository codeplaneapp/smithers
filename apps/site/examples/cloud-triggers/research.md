# Trigger API research

The user requested a first-principles API before inspection of existing Smithers
trigger APIs. `first-principles.md` preserves that baseline. The source comparison
below happened after the baseline was written. The public guide and reference
describe the resulting product contract in present tense; this research and the
type fixture are not evidence that the feature is implemented.

## Lessons from the three products

| Product | Useful pattern | Consequence for Smithers |
| --- | --- | --- |
| Trigger.dev | Tasks have typed payloads; schema tasks also validate at runtime. Schedules can be declared in code. | A selector carries a schema-derived event type, and external input must be validated before launch. |
| CircleCI | Pipeline triggers, workflow filters, job dependencies, and pipeline parameters are separate concepts. Event, configuration, and checkout sources can differ. | Keep event selection separate from work. Record the subscription revision and execution revision explicitly. |
| GitHub Actions | Events have activity filters, branch/path filters, schedules, and manual inputs. | Use typed constructors with event-specific fields and define matching/defaults precisely. |

Trigger.dev's [schema task documentation](https://trigger.dev/docs/tasks/schemaTask)
distinguishes input decoding from the value received by the task. Its
[schedule documentation](https://trigger.dev/docs/tasks/scheduled) separates
declarative and imperative registration, and its
[idempotency documentation](https://trigger.dev/docs/idempotency) identifies a
repeated submission by a supplied key. These suggest separate contracts for
decoded payloads, registration, and delivery identity. They do not establish
exactly-once side effects.

CircleCI's [trigger overview](https://circleci.com/docs/guides/orchestrate/triggers-overview/)
and [GitHub event options](https://circleci.com/docs/guides/orchestrate/github-trigger-event-options/)
show that event selection and source configuration can be independent. Its
[configuration reference](https://circleci.com/docs/reference/configuration-reference/)
describes dependencies, workflow conditions, and job filters. Smithers already
has a work graph, so importing a second job/dependency language would duplicate
that responsibility. This is a design inference, not a claim that CircleCI's
model is defective.

GitHub's [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
defines multiple events as alternatives and combines branch/path requirements.
It also documents order-sensitive negative patterns and pending required checks
after filtering. The recommended contract uses explicit include/exclude lists
with exclusion precedence, plus an explained nonmatch result for required CI.
GitHub's [event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
distinguishes review head, test merge, schedule, and completion contexts. The
Smithers contract records its selected commit instead of allowing event names to
hide checkout behavior.

## Why this public shape

`S.Automation({ on, run, when?, input? })` binds typed selectors to a direct
target or flow reference. It is not another workflow implementation. Target
dependencies and flow bodies continue to express work.

The everyday case has two declarations in `on` and one existing target in `run`.
Advanced cases retain the same shape: a cron selector, a schema for manual or
external input, or a typed reference to an upstream completion. Users do not
write transport handlers for built-in repository events, expression strings,
or duplicate event interfaces.

Alternatives considered:

- Magic behavior attached to a `ci` name hides intent and cannot express other
  events. The user's feedback correctly rejected it.
- A single object of optional event fields is concise but weakens inference
  when one source needs multiple selectors or payload schemas.
- An event registry keyed only by strings loses the relationship between a
  trigger, its payload, and the flow it launches.
- Reusing GitHub-specific workflow syntax would make Plue events feel like
  compatibility aliases and reintroduce another job language.

`when` and `input` remain ordinary typed functions. They require a pinned bundle
and bounded isolated evaluation. Static constructor fields remain serializable
for routing. This has an implementation cost, but avoids inventing a second
expression language.

## Existing Smithers comparison

The relevant sources are:

- `packages/smithers/agent/triggers/src/Trigger.ts`: `Trigger.make` validates
  `id`, `flowId`, JSON `input`, and schedule fields. It is not a typed binding
  between a flow definition and its payload.
- `packages/smithers/agent/triggers/src/Schedule.ts` and `Cron.ts`: reusable
  cron validation, overlap, and bounded catch-up policies.
- `packages/smithers/agent/triggers/src/TriggerStore.ts` and `Scheduler.ts`:
  durable registration, occurrence identity, claims, and control-plane launch.
- `packages/smithers/agent/triggers/src/Channel.ts` and `Webhook.ts`: signature
  verification before schema decoding and delivery through the control plane.
- `packages/smithers/build/targets/src/CronTarget.ts`: a package-level cron
  target associated with generated GitHub CI, not the Cloud subscription API.
- `packages/smithers/flows/flow/src/Flow/Flow.ts`: typed `payloadSchema`,
  `successSchema`, and the accepted `~type.make.in` payload.

Keep the existing scheduler and authenticated-channel boundaries. Add typed
selectors to the existing Trigger module, and add an automation registration
surface that resolves direct references to package/flow identities. Existing
`Trigger.make` remains the low-level cron registration API; it is not silently
reinterpreted as an event selector.

Changes from the preserved baseline:

1. Use `timezone`, matching the existing schedule vocabulary.
2. Reuse `Flow.payloadSchema`, rather than introducing an `input` schema property
   on flow definitions. Mapper values use the flow's accepted construction type,
   then schema encoding before persistence, instead of assuming decoded and
   encoded values are interchangeable.
3. Name the new generic event value `Selector<Event>` to distinguish it from
   the existing nongeneric persisted `Trigger.Trigger` record.

The source comparison did not change the event/binding model. Implementation
must still verify module dependency direction and the host adapter contract;
the type fixture isolates the API question without shipping runtime stubs.

## Validation boundary

`typecheck.ts` compiles against the declaration-only contract and real Effect
schemas. It includes positive cases and expected compiler errors for event
options, event unions, labeled-action narrowing, literal event names, required
flow input, synchronous callbacks, completion output, and decoded dates.

Runtime tests remain necessary for matching, schema validation, trust,
idempotency, cron/DST behavior, activation, and revision selection. They belong
to implementation after documentation review.
