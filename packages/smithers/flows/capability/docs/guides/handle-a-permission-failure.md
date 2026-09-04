---
title: "Handle a permission failure"
description: "Branch the three typed failures a guarded host call can add, recover one from Effect's PlatformError channel, and render it for a log without letting a resource forge a second line."
sidebar:
  order: 2
---

`Permission.PermissionError` is the union of the three failures the permission
kernel adds to a guarded host call. A service that names it in its own error
channel, as [`@smthrs/jj`](/api/jj) does with `JjError | PermissionError`,
forces every caller to decide what each one means.

## Branch the union

Switch on `_tag`. The three cases call for three different responses, and
collapsing them loses the difference between "ask a person", "the answer is no",
and "nobody could answer":

```ts
import { Permission } from "@smthrs/capability"

const describe = (error: Permission.PermissionError): string => {
  switch (error._tag) {
    case "@smthrs/capability/PermissionRequired":
      // Suspend the run and show the request. `capability`, `tier`, and
      // `requestId` are what an approval surface needs.
      return `waiting on ${error.requestId}`
    case "@smthrs/capability/PermissionDenied":
      // Policy or the capability ceiling refused. Retrying changes nothing.
      return `refused: ${error.reason}`
    case "@smthrs/capability/GrantStoreError":
      // The store could not decide. Branch on the stable `code`.
      return `store ${error.code}`
  }
}
```

| Failure              | What it means                                                  | What to do                                                                     |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `PermissionRequired` | The decision was `ask`. The operation did not happen.          | Park the run, show `capability` and `tier` to a person, resolve `requestId`.   |
| `PermissionDenied`   | A rule or the capability ceiling said no. `reason` says which. | Fail the operation. A retry produces the same answer.                          |
| `GrantStoreError`    | Registering, persisting, or resolving the request failed.      | Treat as unavailable, not as a denial. Read `code` to decide whether to retry. |

`GrantStoreError.code` is one of `duplicate_request`, `request_not_found`,
`journal_failed`, `store_closed`, or `invalid_resolution`. Its `message` and
`cause` are operation context for a persistence adapter; they are optional, so
branch on `code`.

## Recover a failure from the platform channel

Effect owns the `FileSystem` and `ChildProcessSpawner` tags, and their error
channel is fixed to `PlatformError`. The kernel decorates those tags in place
rather than minting new ones, so a guarded filesystem call fails with a
`PlatformError` whose structured cause is the permission failure:

```ts
import { Capability, Permission } from "@smthrs/capability"
import { Option } from "effect"

const denied = Permission.permissionDenied(
  Capability.make("fs:write", "/etc/hosts"),
  "outside the workspace"
)

const projected = Permission.toPlatformError({
  module: "FileSystem",
  method: "writeFileString",
  pathOrDescriptor: "/etc/hosts",
  error: denied
})

Option.isSome(Permission.fromPlatformError(projected))
// true
```

Nothing is lost in the projection. The normalized reason is always
`PermissionDenied`, meaning the operation did not happen because the kernel
refused, suspended, or could not decide it. `description` carries the
`Permission.formatError` rendering, and `cause` carries the failure itself, so
an attended surface still gets back the original `capability`, `tier`,
`requestId`, and `reason`.

`fromPlatformError` returns `Option.none()` for any other platform error,
including a foreign one whose `cause` happens to look like a permission
failure. It unwraps only a `PermissionDenied` reason, and it validates the
cause's whole shape.

## Recognize a failure at a boundary

Use `Permission.isPermissionError` where a value arrives as `unknown`: a caught
defect, an RPC payload, a journal row. It checks the exact enumerable shape,
not the `_tag` alone, so it accepts a structurally valid failure produced by
another copy of this dual-published package and rejects a forgery carrying an
extra field, a wrong-typed field, a missing `meta`, or an overlong capability
resource.

`Permission.PermissionError` is also exported as a schema value, so you can
decode a payload rather than refine a value when you need the parsed failure
back.

## Render one line for a log

```ts
Permission.formatError(denied)
// "permission_denied: fs:write:/etc/hosts: outside the workspace"
```

The three renderings are:

```text
permission_required: <action:resource> (tier <tier>, request <requestId>)
permission_denied: <action:resource>: <reason>
grant store <code>: <message>
```

The resource in that line came from an agent. `formatError` escapes C0 and C1
control characters, so a resource containing a newline renders as `\n` instead
of starting a second log line, and it caps each field at
`Permission.maxDisplayFieldLength` (256 UTF-16 code units) with a visible
`…[truncated]` marker. Ordinary non-ASCII text passes through unchanged.

## Put only journal-safe context in `meta`

`PermissionRequired.meta` reaches the grant journal, so it accepts only
JSON-representable values and rejects anything else at the construction site,
naming the key, rather than later at the persistence boundary:

- An object property whose value is `undefined` is dropped, mirroring
  `JSON.stringify`, so a host can pass an optional field it does not have.
- An `undefined` array element is rejected, because serializing it would change
  it to `null` rather than omit it.
- A `bigint`, a `Date`, a `Map`, or a class instance is rejected rather than
  flattened into an empty object.
- A cycle is reported as a schema failure rather than overflowing the stack.

Construction takes a deep-frozen snapshot and never retains your object, and
the `meta` and `capability` slots are non-writable. Mutating the object you
passed does not change the failure.

## Related

- [Effect tiers](../concepts/effect-tiers.md): what `tier` on a suspended
  request tells the person answering it.
- [The `@smthrs/kernel` reference](/api/kernel): the grant store that produces
  these failures and the layers that decorate host services.
