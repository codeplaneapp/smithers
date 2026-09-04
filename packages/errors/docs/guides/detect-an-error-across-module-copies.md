---
title: "Detect an error across module copies"
description: "Choose between isSmithersError and hasSmithersErrorShape: when instanceof is enough, when a structural check is required, and what each refinement refuses."
sidebar:
  order: 3
---

The package ships two refinements for the same question, and they answer it
differently on purpose.

```ts
import { hasSmithersErrorShape, isSmithersError } from "@smthrs/errors"
```

## Use isSmithersError by default

`isSmithersError` is `value instanceof SmithersError` and nothing else. It is
exact, it accepts every subclass, and it cannot be forged by an object that
merely looks right:

```ts
isSmithersError(new SmithersError("INVALID_INPUT", "x")) // true
isSmithersError(new Subclass("INVALID_INPUT", "x")) // true
isSmithersError(new Error("plain")) // false

const forged = new Error("forged")
forged.name = "SmithersError"
isSmithersError(forged) // false
```

Use it when the error was raised by code that resolves the same copy of
`@smthrs/errors` you did, which is the normal case inside one application or
one workspace build.

## Use hasSmithersErrorShape across a boundary

`instanceof` compares prototypes, so it answers `false` for an error built by a
second copy of the package: a duplicated dependency, a bundled build beside a
source build, a plugin loaded from its own `node_modules`. The error is right;
the identity check is asking the wrong question.

`hasSmithersErrorShape` asks the structural question instead. The value must:

- be an `Error`,
- carry a `code` that `isSmithersErrorCode` accepts, so a string outside the
  five documented codes is refused,
- carry `summary` and `docsUrl` as strings,
- carry `details` that is either absent or a non-null, non-array object.

```ts
const error = new SmithersError("INVALID_INPUT", "x")
Object.setPrototypeOf(error, Object.getPrototypeOf(new Error()))

isSmithersError(error) // false, the prototype is gone
hasSmithersErrorShape(error) // true, every field still checks out
```

It narrows to `SmithersError`, and `error.code` narrows to
`SmithersErrorCode`, so a `switch` after it is exhaustive even though the value
came from outside.

## What the structural check still refuses

The check is stricter than a `name` comparison, which is the point:

```ts
hasSmithersErrorShape(new Error("plain")) // false, no code
hasSmithersErrorShape({ code: "INVALID_INPUT", summary: "x", docsUrl: "u" }) // false, not an Error
hasSmithersErrorShape(Object.assign(new Error("f"), { code: "NOT_A_CODE", summary: "s", docsUrl: "u" })) // false
hasSmithersErrorShape(Object.assign(new Error("f"), { code: "INVALID_INPUT" })) // false, incomplete
```

A `details` value that is a string, `null`, a number, or an array is refused
too. Every one of those would break a caller that spreads or reads keys from
`details`.

What it cannot refuse is a deliberate forgery: a plain `Error` with all four
fields set correctly passes. The refinement answers "this value is safe to
read as a `SmithersError`", not "this value was raised by Smithers". Use it on
values from a module boundary you trust, not on values from a network.

## Build the same pair for your subclass

A subclass refinement combines both, because neither is sufficient alone:
`instanceof` misses the cross-copy instance, and a `name` check accepts a
forgery. Check the class or the name, then the structure, then the extra
fields your own conversions read.
`Core.IntegrationError.isIntegrationError` in
[`@smthrs/integrations`](/api/integrations) is the worked example, and
[Raise a SmithersError from an adapter](./raise-an-error.md#ship-a-refinement-with-the-subclass)
walks through it.
