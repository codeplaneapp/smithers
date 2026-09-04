---
title: "@smthrs/capability"
description: "The leaf vocabulary of the Smithers permission kernel: capability values, wildcard patterns, effect tiers, policy rules, and the three typed failures a guarded host call can add."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/capability/docs/README.md"
---

`@smthrs/capability` is the vocabulary the Smithers permission kernel decides
with. It holds the words, never the enforcement.

A **capability** is one host operation an agent asked for, written as an action
and a resource: `fs:read` on `/workspace/README.md`, `proc:spawn` on
`npm install`. A **capability pattern** is the same shape with a resource glob,
so it names a set of operations instead of one. A **rule** pairs a pattern with
`allow`, `deny`, or `ask`, and `Permission.evaluate` reduces the rules that
match a request into one decision. An **effect tier** says what retrying that
operation costs. Everything that acts on a decision, the grant store, the
decorated host services, and the journal, lives in
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/).

The package depends on `effect` and nothing else. It provides no services and
no layers: every export is a value, a schema, or a pure function.

## The smallest real example

```ts
import { Capability, Permission } from "@smthrs/capability"

const policy = [
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
  })
]

Permission.evaluate([policy], Capability.make("fs:read", "/workspace/README.md"))
// "allow"
Permission.evaluate([policy], Capability.make("fs:write", "/workspace/README.md"))
// "ask"
```

The second call returns `ask` because no rule matched, and the default for an
unmatched request is to ask a person. Nothing here silently allows.

## Who uses this package

Host adapters build a `Capability` for each operation they are about to perform
and hand it to the kernel. Protected services name `Permission.PermissionError`
in their own error channel, so a caller holding the service cannot forget that
an operation may be suspended, denied, or left undecided. Operators and config
readers write patterns, and `Capability.parsePattern` is what turns their text
into a rule.

## Why it is its own package

A protected host service declares permission failures in its own interface:
`@smthrs/jj`'s `Jj` fails with `JjError | PermissionError`, not with a widened
copy of itself minted by the kernel. Minting that copy would make
[`@smthrs/jj`](https://jj.smithers.sh/reference/api/) depend on [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/), which already
depends on `@smthrs/jj`. Both depend on this leaf instead.

## The package at a glance

The root entry point exports two namespaces, and each is also importable from
`@smthrs/capability/<Module>`:

| Namespace    | What it is                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Capability` | The `Capability` value, the `CapabilityPattern` glob, the closed action vocabulary, the `action:resource` text form, matching, and effect tiers. |
| `Permission` | The three typed failures, the policy `Rule`, `evaluate`, the one-line renderer, and the projection into Effect's `PlatformError` channel.        |

Every export, with signatures and behavior, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, import forms, and what this
  package deliberately does not ship.
- [Quickstart](/quickstart/): decide one request against a policy, end to
  end.
- Concepts: [the authorization model](/concepts/authorization-model/),
  [resource globs](/concepts/resource-globs/), and
  [effect tiers](/concepts/effect-tiers/).
- Guides: [grant a capability safely](/guides/grant-a-capability-safely/),
  [handle a permission failure](/guides/handle-a-permission-failure/), and
  [validate capability text from an untrusted source](/guides/validate-untrusted-text/).
- [Troubleshooting](/troubleshooting/): the refusals this package returns,
  what causes each one, and what to change.
