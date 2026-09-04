---
title: "Handle a failed tool call"
description: "Tell a tool that reported a problem from a session that broke: the isError success channel, the seven McpError codes, and how a remote JSON-RPC error is classified."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/guides/handle-a-failed-tool-call.md"
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

The message always names the server and includes the numeric code the server
sent. A scalar `data` field of 120 characters or fewer is appended as
`[data: ...]`.

## What an error never contains

Nothing retains the request, the arguments, or the raw frame:

- An argument that is not JSON is reported by a bounded property path, such as
  `arguments.payload.handler`, truncated at 120 characters, plus what was wrong
  with it.
- A structured-output violation names the path inside `structuredContent`, not
  the value.
- A `spawn_failed`, `timeout`, or `connection_closed` carries a bounded tail of
  the child's stderr, whitespace-collapsed, up to `maxStderrBytes`.

Reaching for the raw frame in a log is the wrong move: it is not there on
purpose, because a tool argument can carry a credential.

## Arguments must be JSON before they are sent

`callTool` snapshots its arguments before writing a frame, and rejects anything
that is not plain JSON with `protocol_error`: a function, a symbol, a bigint,
`undefined`, a non-finite number, a cyclic reference, an object with a non-plain
prototype, an accessor property, a symbol-keyed property, or a `toJSON` method.
Accessors are rejected rather than invoked, and a property that throws when read
becomes a typed error rather than a defect.

This runs before the wire, so a bad argument never reaches the server and never
consumes a request deadline.

## Next

- [Troubleshooting](/troubleshooting/): each failure by symptom, with the
  fix.
- [Validate structured output](/guides/validate-structured-output/): the one
  `invalid_response` a healthy server can still produce.
