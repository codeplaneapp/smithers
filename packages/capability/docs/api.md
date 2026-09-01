```ts
import { Capability, Permission } from "@smthrs/capability"

const rule = new Permission.Rule({
  effect: "allow",
  pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
})
```

Enforcement, the `GrantStore`, the decorating layers, and the journal live in
[`@smthrs/kernel`](/api/kernel). This package depends on `effect` alone, so both
the kernel and `@smthrs/jj` can depend on it without a cycle and a protected
service names permission failures in its own interface.

:::danger
Schema ids (`@smthrs/capability/Capability`, `@smthrs/capability/PermissionDenied`, and the rest) are digested into step keys and round-trip through the grant journal. Renaming one invalidates recorded runs.
:::

## Entry points

| Import                          | Source                                                                                                      | Platform |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/capability`            | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/index.ts)           | any      |
| `@smthrs/capability/Capability` | [src/Capability.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/Capability.ts) | any      |
| `@smthrs/capability/Permission` | [src/Permission.ts](https://github.com/smithersai/smithers/blob/main/packages/capability/src/Permission.ts) | any      |

## Actions and tiers

`Capability.Action` is the closed vocabulary: `fs:read`, `fs:write`, `net:get`,
`net:post`, `model:call`, `proc:spawn`, and the jj slot's `jj:status`,
`jj:diff`, `jj:snapshot`, `jj:restore`, `jj:workspace-add`,
`jj:workspace-forget`, `jj:root`, and `jj:revert`. Actions are durable identity:
never repurpose one, add one. `Capability.PatternAction` adds the namespace
selectors `fs:*`, `net:*`, `model:*`, `proc:*`, `jj:*`, and the whole-authority
`*`. Both are exported as schema values, so a consumer can validate a bare
selector at an RPC, config, or persistence boundary instead of copying the list.

`Capability.tierOf` classifies a capability. Reads are `sealed` (`fs:read`,
`net:get`, `model:call`, `jj:status`, `jj:diff`, `jj:root`). Undoable writes are
`compensable` (`jj:snapshot`, `jj:restore`, `jj:workspace-add`,
`jj:workspace-forget`, `jj:revert`, and an `fs:write` inside the workspace
root). The rest are `irreversible` (`net:post`, `proc:spawn`, and an `fs:write`
that escapes the workspace), and only those require an idempotency key to retry.

Workspace containment is lexical, so `tierOf` cannot see symlinks: a caller that
materializes snapshots resolves real paths before classifying a write. A
`workspaceRoot` that normalizes to `.` or the empty string has no lexical
boundary and fails closed to `irreversible`, so pass an absolute root.

## Resource globs

A `Capability` carries an exact resource. A `CapabilityPattern` carries a glob
matched against the whole resource:

| Form                        | Meaning                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `*`                         | any run of UTF-16 code units, path separators and newlines included                                                                         |
| `?`                         | exactly one UTF-16 code unit, so an astral character such as an emoji needs two                                                             |
| a space then `*` at the end | also matches the bare resource without its trailing argument text, which is what makes the `proc:spawn` grant `npm *` also grant bare `npm` |
| `**`                        | the only form `Capability.subsumes` can prove                                                                                               |

Three consequences the grammar does not make obvious.

There is no escape. A resource that genuinely contains `*` or `?` cannot be
granted exactly, so an operator writing `net:get:https://api.test/v1?k=1`
believes they wrote an exact resource and has written a one-character wildcard.
Never build a pattern by concatenating agent-supplied text; derive it with
`Capability.patternFromCapability`, which returns `Option.none()` for a resource
the grammar cannot express exactly or one longer than
`Capability.maxResourceLength`.

Matching compares the pattern against the whole resource byte-exactly over
UTF-16 code units. It performs no path normalization and no case folding, so
`\` is an ordinary character that never matches `/`, and `A:/x` never matches
`a:/X`.

Matching costs O(pattern length times resource length) in the worst case. Exact
and pattern resources are both bounded at `Capability.maxResourceLength`
UTF-16 code units and reject anything longer at construction, parsing, and
decode. Adapters reject or summarize larger host values before authorization.
`Capability.maxMatchWork` remains a fail-closed guard for unchecked structural
inputs. `Capability.withinMatchBudget` reports that case and
`Permission.evaluate` denies it.

`Capability.format` renders a capability or a pattern as `action:resource`, and
it is the durable identity a grant envelope is deduplicated and sorted by.
`Capability.parse` reads back an exact capability and `Capability.parsePattern`
reads back a pattern, including the whole-authority `*:**`. Both return
`Option.none()` rather than guessing: a missing resource is a rejection, not a
default.

## Permission failures

`Permission.PermissionRequired`, `Permission.PermissionDenied`, and
`Permission.GrantStoreError` are the three failures a guarded Host call can add,
and `Permission.PermissionError` is exported as both their union type and a
schema value. `Permission.isPermissionError` validates the exact enumerable
shape rather than the `_tag` alone, because the package ships dual cjs and esm
and class identity is not stable for a dual-package consumer. Unknown fields
and overlong nested capabilities are rejected.

`Permission.PermissionRequired.meta` is journal-safe context: only
JSON-representable values are accepted, undefined-valued object properties are
dropped, construction takes a cycle-safe deep-frozen snapshot, and the caller's
object is never retained. Undefined array elements remain invalid because
serializing them would change them to null. Permission failures defensively copy
caller capabilities; the copied action and resource and the outer `capability`
and `meta` slots are non-writable. A value the journal could not encode fails at
the construction site with a decode error naming the key, not later at the
persistence boundary.

`Permission.formatError` renders one line for a log or an unattended report. It
escapes C0 and C1 controls and caps each field at
`Permission.maxDisplayFieldLength`, so an agent-chosen resource cannot inject
extra lines into an operator's log.

## The `PlatformError` projection

Effect owns the `FileSystem` and `ChildProcessSpawner` tags and their error
channels are fixed to `PlatformError`. Rather than mint a second tag whose only
difference is a wider error type, the kernel decorates those tags in place and
maps its failures through `Permission.toPlatformError`: the normalized reason is
always `PermissionDenied`, `description` carries the `Permission.formatError`
rendering, and `cause` carries the structured failure itself.
`Permission.fromPlatformError` recovers it, so an attended surface can still
reply to a `PermissionRequired` request and an unattended report can still name
the capability. It unwraps only a `PermissionDenied` reason, so a foreign
platform error's `cause` never reaches the refinement.

See the [kernel reference](/api/kernel) for the decorating layers and grant
handling.
