# Trigger API baseline, before inspecting existing Smithers trigger APIs

This baseline is derived from the user's requirements and the official Trigger.dev, CircleCI, and GitHub Actions documentation. Existing Smithers trigger implementations have not been inspected during this design pass. Earlier conversation contained Plue event handling; that infrastructure is not the API authority.

## Recommendation

A trigger is a typed subscription to an event. An automation binds one or more subscriptions to an existing target or flow. Work, event selection, and operational authorization stay separate.

```ts
const ci = S.Automation({
  on: [
    T.push({ branches: ["main"] }),
    T.review({ base: ["main"] }),
  ],
  run: prePush,
})

export const Package = S.Package({
  targets: { prePush },
  automations: { ci },
})
```

The binding has the stable package label //:ci. The work keeps its existing label and local command. No implicit triggers attach merely because a target is named ci. One on array, always non-empty, means OR. All fields within a selector mean AND. Multiple matching selectors for the same binding and event produce one run with all matching reasons.

## Event constructors

- T.push({ branches?, paths? }): branch/bookmark updates, never tag updates/deletions. Omitted branches means all branches/bookmarks. Branch is a common API term for a Git branch or Plue bookmark.
- T.review({ actions?, base?, head?, paths?, drafts? }): portable pull request / landing request events; actions are opened, reopened, updated, ready, labeled, closed, merged. Default actions are opened, reopened, updated, ready; updated means changed source commit, not edited metadata. Drafts default false. base and head explicitly distinguish destination and source.
- T.tag({ names? }): created tags, resolved to a commit.
- T.schedule({ cron, timeZone?, ref? }): five-field cron, UTC and default branch/bookmark by default; validated expression and IANA time zone. Occurrences have scheduledAt, not a claim of precise start time.
- T.manual({ input? }): authorized app/CLI/API launch with a schema; decoded input is inferred. Empty object input when omitted. This declares availability, not permission.
- T.event({ name, input }): authenticated custom event with a literal name and a required runtime schema. HTTP signature verification belongs to the registered event source; a schema alone is not authentication.
- T.succeeded(automation): typed successful completion of the referenced automation; original cause and typed output remain available. Same-run ordering stays in the existing target/flow graph.

Filters use non-empty literal/glob lists or { include?, exclude? }. Exclusion wins independent of order; no ! pattern syntax. Arrays are OR. Path sets include deleted paths and both rename sides. Unavailable/incomplete diffs admit the run conservatively and report the fallback. Repo-event shape and literal action/name tags form discriminated unions.

## Binding and type safety

S.Automation({ on, run, when?, input? }) takes one existing target or Flow. Use an existing Suite to group targets. run identity determines the required input contract; input cannot widen that contract. Target bindings have no input mapper. A flow with required input requires a mapper; a void-input flow does not. when is a synchronous boolean predicate over the inferred union from on; input maps the same union to the flow's encoded input type. Payloads are decoded at ingress; mapped inputs are validated by the destination flow schema before launch. No any, explicit user casts, or duplicate event interfaces are required. Schema transformations retain their distinct decoded and encoded types.

```ts
const deploy = S.Automation({
  on: [T.manual({ input: deployFlow.input })],
  run: deployFlow,
  input: event => event.input,
})
```

```ts
const publish = S.Automation({
  on: [T.succeeded(build)],
  when: event => event.cause.type === "push" && event.cause.branch === "main",
  run: publishFlow,
  input: event => ({ artifact: event.output.artifact }),
})
```

when/input functions are compiled as part of a pinned declaration bundle and run with bounded time and no credentials/network, not serialized as function strings or evaluated in the public API process. A thrown predicate is a configuration failure, not a nonmatch.

## Execution semantics

Activation is authorized once per repository. Versioned subscriptions come from the trusted default branch/bookmark and are reconciled atomically; an invalid revision preserves the last valid registration and reports failure. Push/review/tag work executes at the event commit. Schedule/manual/custom event work resolves a permitted ref once. A succeeded continuation uses the upstream execution commit and passes through the original trust classification. Every receipt records subscription revision, execution revision, event identity, and matched selectors. A retry retains its original receipt; newly authorized reruns have separate attempt identity. Same commit is not an idempotency key: separate events can represent different work.

Schedule occurrence identity includes registered schedule identity and scheduled instant. Default missed-occurrence policy is skip and record; no unbounded catch-up. DST gaps skip; repeated local times fire once. Concurrency, run retries, and deadlines are execution policy, not event matching. Required CI has an explicit result for an event even when a selector rejects it: filtering is recorded and does not manufacture passing work. Runtime admission and branch requirements still govern whether a filtered result can satisfy a gate. New required bindings need review-event coverage.

Default hosting remains https://api.jjhub.tech, on the existing Plue infrastructure. Event matching never grants privileges; it is intersected with repository policy. Fork or untrusted events cannot acquire credentials by switching trigger type or chaining completions.

## Research sources

- https://trigger.dev/docs/tasks/schemaTask
- https://trigger.dev/docs/tasks/scheduled
- https://trigger.dev/docs/triggering
- https://trigger.dev/docs/idempotency
- https://circleci.com/docs/guides/orchestrate/triggers-overview/
- https://circleci.com/docs/guides/orchestrate/github-trigger-event-options/
- https://circleci.com/docs/reference/configuration-reference/
- https://circleci.com/docs/guides/orchestrate/pipeline-variables/
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax

## Remaining naming/integration questions for the subsequent source comparison

Which existing module should own typed event descriptors, and is there already an automation binding or app registry for target/flow references? Reuse compatible runtime and source adapters without inheriting a weaker public contract. Names here are baseline names; any changes after comparison must be identified explicitly.
