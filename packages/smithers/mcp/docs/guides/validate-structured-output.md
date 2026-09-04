---
title: "Validate structured output"
description: "What the client checks when a tool declares an outputSchema and returns structuredContent: the five supported JSON Schema keywords, what is ignored, and how a violation is reported."
sidebar:
  order: 5
---

A tool may declare an `outputSchema` and answer with `structuredContent`. When
both are present, this client validates the value against that schema before
returning it, so a downstream consumer never sees structured output the server's
own contract rejects.

You do not switch this on. It applies whenever the catalog entry declared a
schema.

## What is checked

The validator is dependency-free and supports exactly five keywords:

| Keyword      | Behavior                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `type`       | All seven JSON Schema type names (`null`, `boolean`, `object`, `array`, `number`, `string`, `integer`), and arrays of names. |
| `required`   | Each named string property must be an own property of the object.                                                            |
| `properties` | Each declared property present in the value is validated against its subschema.                                              |
| `items`      | A single schema applied to every element of an array. Tuple form is not supported.                                           |
| `enum`       | The value must equal one of the declared values, compared by JSON value rather than by reference.                            |

Validation recurses through `properties` and `items`, so a schema three levels
deep is checked three levels deep.

## What is ignored

Every other keyword. `minLength`, `pattern`, `additionalProperties`, `oneOf`,
`$ref`, and the rest are skipped.

This is a deliberate choice, not an oversight: a partial validator that rejected
data for a constraint it does not implement would be worse than one that admits
what it cannot judge. A tool whose contract depends on `pattern` should validate
its own output.

## How a violation is reported

A violation fails with `invalid_response`, naming the path inside
`structuredContent` and what was expected:

```text
MCP server "reports" returned structuredContent that its own outputSchema
rejects at structuredContent.answer: expected number
```

Paths are built as you would write them, `structuredContent.rows[2].id`, and
truncated to 120 characters. The message names the constraint, never the value,
so a credential in a tool result does not reach a log through an error.

Validation never mutates or replaces the server's value. It either passes it
through unchanged or fails.

## The shapes a result may take

Three combinations are all valid:

| Result                   | Outcome                                                |
| ------------------------ | ------------------------------------------------------ |
| `content` only           | Returned as sent, with `structuredContent: undefined`. |
| `structuredContent` only | Accepted, and returned with `content: []`.             |
| Both                     | Both returned.                                         |

A result carrying neither fails with `invalid_response`. A `content` value that
is not an array, a `content` element that is not an object, an `isError` that is
not a boolean, or a `structuredContent` that is not a JSON object all fail the
same way.

Without a declared `outputSchema`, any JSON-object `structuredContent` passes
through unchanged.

## Reading it downstream

`McpFlows.Result` carries the field through the flow's output schema, so a cell
sees it directly:

```js
const report = await ctx.call("mcp/reports/summary", { period: "2026-Q1" })
const rows = report.structuredContent?.rows ?? []
```

`structuredContent` is optional on the flow output, so a tool that never sends
one produces a result with the field absent rather than null.

## Next

- [Handle a failed tool call](./handle-a-failed-tool-call.md): the other
  failures a call can produce.
- [Bound an untrusted server](./bound-an-untrusted-server.md): the limits that
  apply before validation ever runs.
