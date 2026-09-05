---
title: "The authorization model"
description: "What a capability is, how ordered rulesets reduce to one decision, why a configured deny is final, and the four places the model refuses to guess."
sidebar:
  order: 1
---

Authorization here answers one question about one operation: may this exact
request proceed, right now, under the rules that currently apply. The answer is
`allow`, `deny`, or `ask`. Everything else, remembering an answer, waking a
person, journaling the grant, belongs to [`@smthrs/kernel`](/api/kernel).

## Two values, and why they are different types

A `Capability` is the request. It is exact: `fs:write` on
`/workspace/out.txt`, `proc:spawn` on `npm install --offline`. An adapter builds
one from the arguments it is about to use, so nothing is left to interpretation
at the moment of the call.

A `CapabilityPattern` is a grant. Its action may be a family selector (`fs:*`,
`*`), and its resource is a glob, so it names a set. An operator writes
patterns; an adapter never does.

The types differ because the directions differ. Matching runs pattern against
request and answers "is this one in that set". It never runs request against
request, and it never treats a request's literal text as a glob. Keeping them
apart is what makes `Capability.patternFromCapability` a deliberate,
checkable step rather than an implicit cast: see
[Grant a capability safely](../guides/grant-a-capability-safely.md).

## How rules reduce to a decision

A `Rule` is a pattern plus an effect. `Permission.evaluate` takes ordered
rulesets and one capability, and reduces them in three passes.

1. **Decidability.** If any rule in any ruleset cannot be matched against this
   request inside the work budget, the answer is `deny` and the reduction
   stops. Skipping such a rule could let an undecidable `deny` fall through to
   a later `allow`.
2. **Configured policy.** `rulesets[0]` is reduced on its own, last match wins.
   If its effective answer is `deny`, that is the answer.
3. **Everything.** All rulesets are reduced together, last match wins, and the
   default when nothing matches is `ask`.

[`@smthrs/kernel`](/api/kernel) supplies four rulesets in this order:
configured policy, the patterns approved for a run before it starts, the grants
the run has since been given, and the grants a person chose to remember. So a
later grant can raise a request from `ask` to `allow`, and it can lower an
`allow` back to `deny`, but it can never lift what configured policy already
denied. That ordering is described in
[how a grant decision is made](/pkg/kernel/concepts/grant-decisions).

Note what pass 2 reduces before it vetoes. A configured `deny` followed by a
configured `allow` for the same request is not a veto: within configured policy
the later rule is the operator's more recent word. The veto applies to the
answer configured policy arrives at, not to the presence of a `deny` line.

```ts
import { Capability, Permission } from "@smthrs/capability"

const request = Capability.make("fs:read", "/workspace/readme.md")
const rule = (effect: Permission.RuleEffect, action: Capability.PatternAction, resource: string) =>
  new Permission.Rule({ effect, pattern: new Capability.CapabilityPattern({ action, resource }) })

// Configured policy settles on allow, so a session ruleset still applies.
Permission.evaluate(
  [[rule("deny", "fs:*", "/workspace/**"), rule("allow", "fs:read", "/workspace/readme.md")], [rule("ask", "*", "**")]],
  request
)
// "ask"

// Configured policy settles on deny, so nothing later is consulted.
Permission.evaluate(
  [[rule("allow", "fs:read", "/workspace/readme.md"), rule("deny", "fs:*", "/workspace/**")], [
    rule("allow", "*", "**")
  ]],
  request
)
// "deny"
```

A configured `ask` is not a veto. It is an ordinary rule, and a later grant may
answer it. That is how a remembered approval works.

## Where the model refuses to guess

Every ambiguity in this package resolves toward asking or refusing, never
toward proceeding. Four cases carry that rule, and each one is worth
recognizing when a decision surprises you:

| Situation                                           | Answer          | Why                                                             |
| --------------------------------------------------- | --------------- | --------------------------------------------------------------- |
| No rule matches                                     | `ask`           | Silence is not consent.                                         |
| A rule is too expensive to match                    | `deny`          | An undecidable `deny` must not fall through to a later `allow`. |
| A resource cannot be expressed exactly as a pattern | `Option.none()` | Returning a pattern would silently widen the grant.             |
| A workspace root has no lexical boundary            | `irreversible`  | An unbounded write cannot be treated as undoable.               |

The cost bound behind the second row is real, not theoretical. Matching costs
O(pattern length times resource length), both sides are capped at
`Capability.maxResourceLength` (4096 UTF-16 code units), and
`Capability.maxMatchWork` is the square of that cap. An ordinary grant such as
`/workspace/**` still decides a resource well over a million units long, so the
budget only bites when a structural input evaded the length check at the host
boundary. `Capability.withinMatchBudget` reports that case before you evaluate.

## Stable identity

Two of the strings this package produces are identity rather than display text:
the schema ids (`@smthrs/capability/Capability`,
`@smthrs/capability/PermissionDenied`, and the rest) and the `action:resource`
text `Capability.format` renders. A stored decision keeps those exact strings
and is read back through them, so render capability text with
`Capability.format` wherever it will be read again, rather than assembling it
yourself.

The action vocabulary carries the same weight. `fs:read`, `net:post`,
`jj:snapshot` and the rest are a closed set that grows by addition; an existing
action does not change meaning. A stored payload naming an action outside the
set fails to decode rather than being read as something adjacent.

## Related

- [Resource globs](./resource-globs.md): the matching grammar and its edges.
- [Effect tiers](./effect-tiers.md): what a decision costs to undo.
- [The `@smthrs/kernel` reference](/api/kernel): the grant store and the layers
  that enforce a decision.
