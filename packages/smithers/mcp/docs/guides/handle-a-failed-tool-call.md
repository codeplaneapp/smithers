---
title: "Handle a failed tool call"
description: "Tell a tool that reported a problem from a session that broke: the isError success channel, the seven McpError codes, and how a remote JSON-RPC error is classified."
sidebar:
  order: 4
---

Two different things are called a failure here, and they arrive on two different
channels. Getting them mixed up is the most common mistake in code that calls
MCP tools.

## A tool that reports a problem is a success

MCP distinguishes "the call failed" from "the tool ran and reported a problem".
The second one is a successful JSON-RPC reply carrying `isError: true`, and this
package returns it in the success channel with the tool's own content blocks:

```ts
const result = yield * client.callTool("explode", {})
// result.isError === true
// result.content === [{ type: "text", text: "the tool refused" }]
```

A cell reads it the same way:

```js
const outcome = await ctx.call("mcp/fixtures/explode", {})
if (outcome.isError) {
  // The tool ran. This is its answer, not an exception.
}
```

Treat `isError` as data. It usually carries the message the model needs to fix
its own arguments, and turning it into a thrown failure loses that.

## A broken session is an McpError

`McpError` is reserved for failures of the MCP session itself. It carries a
stable `code`, a human-readable `message`, and the `server` name:

| Code                | What happened                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `spawn_failed`      | The server process would not start.                                                                  |
| `connection_closed` | The process exited or a pipe closed while a request was outstanding.                                 |
| `timeout`           | The server did not answer within the deadline for that method.                                       |
| `protocol_error`    | Negotiation failed, an envelope was malformed, or an option was invalid.                             |
| `tool_not_found`    | The catalog has no such tool, `include` named a missing tool, or the server rejected an unknown one. |
| `tool_failed`       | The server rejected a `tools/call` with a JSON-RPC error.                                            |
| `invalid_response`  | A well-formed reply carried a `tools/list` or `tools/call` payload this client rejects.              |

The codes are a schema (`McpError.Code`), so matching on them is stable:

```ts
import * as McpError from "@smthrs/mcp/McpError"
import { Effect } from "effect"

const tolerant = client.callTool("search", { query }).pipe(
  Effect.catchTag("flows/mcp/McpError", (error) =>
    error.code === "timeout"
      ? Effect.succeed({ content: [], isError: true, structuredContent: undefined })
      : Effect.fail(error))
)
```

## How a remote JSON-RPC error is classified

When a server answers a `tools/call` with a JSON-RPC error rather than a result,
the code depends on what the server said:

- JSON-RPC `-32601` or `-32602`, **and** a message that combines the word `tool`
  with `unknown`, `unrecognized`, `no such`, or `not found`, becomes
  `tool_not_found`.
- Every other `tools/call` error becomes `tool_failed`, including an ordinary
  invalid-arguments rejection.
- A JSON-RPC error on any other method becomes `protocol_error`.

The heuristic is deliberately narrow because servers do not standardize
unknown-tool prose. An argument validation failure stays `tool_failed`, which is
the truthful answer: the tool exists and refused the call.

The message names the configured server and includes the numeric code the
server sent. Remote message text and `data` are withheld, even when short: a
short scalar can still be a credential.

## What an error never contains

An ordinary session error contains neither the request nor raw remote details:

- A non-JSON argument or structured-output violation reports a fixed reason,
  withholding both its value and property path. Property names can be secrets.
- Invalid protocol versions, duplicate tool names, and repeated cursors are
  reported without echoing the server's strings.
- Process startup errors, child stderr, and remote error messages/data never
  enter the ordinary error, its encoded schema, or its JSON representation.

For debugging, a trusted host can opt into
[Diagnostics](../api.md#diagnostics). Its bounded details are wrapped in
`Redacted`; ordinary inspection and JSON serialization hide them. Unwrapping
requires explicit access and retention controls. Never send unwrapped details
to an agent, journal, trace, or routine log. Without an observer these details
are discarded. This is not a scrubber for successful tool output, including
`isError: true`: that data is returned unchanged.

## Arguments must be JSON before they are sent

`callTool` snapshots its arguments before writing a frame, and rejects anything
that is not plain JSON with `protocol_error`: a function, a symbol, a bigint,
`undefined`, a non-finite number, a cyclic reference, an object with a non-plain
prototype, an accessor property, a symbol-keyed property, or a `toJSON` method.
Accessors are rejected rather than invoked, and a property that throws when read
becomes a typed error rather than a defect.

This runs before the wire, so a bad argument never reaches the server and never
consumes a request deadline.

The argument root must be an object. Deep nesting and expanded JSON size are
also [bounded](./bound-an-untrusted-server.md#json-depth-and-expansion), including
when many properties reference the same child object.

## Next

- [Troubleshooting](../troubleshooting.md): each failure by symptom, with the
  fix.
- [Validate structured output](./validate-structured-output.md): the one
  `invalid_response` a healthy server can still produce.
