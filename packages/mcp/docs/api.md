A remote MCP server's tools are not a second kind of capability the harness has
to know about. `@smthrs/harness/FlowBinding`'s own contract already names this
case: "a standard filesystem flow, a memory flow, an incoming MCP tool, a
durable child agent" are all just a flow declaration plus the code that runs it.
This package is the code that runs it. `McpClient` speaks stdio JSON-RPC to a
spawned server, and `McpFlows` turns the resulting tool catalog into one
`FlowBinding.Binding` per tool.

## Usage

`McpFlows.connected` needs `ChildProcessSpawner` and a `Scope`, the same
services a host already provides for `StandardFlows.shell`. The connection's
lifetime is the scope's lifetime: closing the scope tears down the spawned
server.

```typescript
import { NodeServices } from "@effect/platform-node"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const source = yield* McpFlows.connected({
    server: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "..." }
  })
  // source: FlowBinding.Source. Pass it to FlowBinding.catalog(...) alongside
  // StandardFlows.filesystem(...), StandardFlows.shell(...), and any other
  // source the host composes.
  return source
}))

await Effect.runPromise(Effect.provide(program, NodeServices.layer))
```

`env` is merged into the inherited child environment rather than replacing it,
so a server spawned with a credential still receives `PATH` and `HOME`.

Each tool becomes a flow named `mcp/<server>/<tool>`, with the server's own JSON
Schema disclosed as the flow's input document so a caller reading `ctx.flows`
sees the real parameter shape. `include`, `exclude`, and `namePrefix` narrow and
rename that projection before any descriptor exists, which is how a host keeps a
fifty-tool server out of the model's context window.

## Declared authority

`McpFlows.capabilities` is derived from `Capability.Action.literals`: one exact
`namespace:operation:resource` string per action, at resource `**`. It is spelled
out one action at a time because the cell boundary reads a declared capability
with `Capability.parse`, which takes an exact three-component action and rejects
anything else. A bare `"*"` parses as nothing, and an unparseable declaration is
treated as unauthorized, so a wildcard would refuse every MCP tool with
`capability_refused` before it ran, even under an unrestricted envelope. The
list is derived rather than restated so a new action in `@smthrs/capability`
cannot be silently dropped.

`McpFlows.effects` declares `tier: "irreversible"` with `reads` and `writes` of
`**`. An MCP tool is opaque code this adapter does not control, so the honest
declaration is everything.

## Limits

Every limit is an option on `McpClient.connect` with an exported default
constant. The defaults exist because the server is untrusted: it sizes the
frames it sends, the catalog it declares, and the flow names the model sees.

| Option                  | Default | What it bounds                                      |
| ----------------------- | ------- | --------------------------------------------------- |
| `handshakeTimeoutMs`    | 10000   | Each `initialize` and `tools/list` exchange.        |
| `requestTimeoutMs`      | 120000  | Each later `tools/call` exchange.                   |
| `queueCapacity`         | 64      | Outbound frames waiting to be written.              |
| `maxFrameBytes`         | 1 MiB   | One inbound JSON-RPC frame.                         |
| `maxOutboundFrameBytes` | 1 MiB   | One outbound JSON-RPC frame.                        |
| `maxTools`              | 256     | Tools accepted across every catalog page.           |
| `maxToolNameBytes`      | 128     | UTF-8 bytes in one tool name.                       |
| `maxCatalogPages`       | 32      | `tools/list` pages walked while following a cursor. |
| `maxStderrBytes`        | 2048    | Child stderr retained as a diagnostic tail.         |

A tool name may not contain `/`, a C0 control character, or U+007F, because the
name reaches the model inside a flow name and the journal inside a declaration
digest.

## Failures

An ordinary tool outcome stays in the success channel: a remote tool that
reports failure returns `isError: true` with its own content blocks, and the
flow succeeds. `McpError` is reserved for failures of the MCP session itself.

| Code                | Meaning                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `spawn_failed`      | The server process would not start.                                                     |
| `connection_closed` | The process exited or a pipe closed while a request was outstanding.                    |
| `timeout`           | The server did not answer within the deadline for that method.                          |
| `protocol_error`    | Negotiation failed, an envelope was malformed, or an option was invalid.                |
| `tool_not_found`    | The catalog has no such tool, or `include` named one the server does not offer.         |
| `tool_failed`       | The server rejected a `tools/call` with a JSON-RPC error.                               |
| `invalid_response`  | A well-formed reply carried a `tools/list` or `tools/call` payload this client rejects. |

Every message names the server. A JSON-RPC error message carries the numeric
code the server sent. Nothing retains the request, the arguments, or the raw
frame: an argument that is not JSON is reported by a bounded property path, and
a failed startup is explained by a bounded tail of the child's stderr.

## Scope

- stdio transport only. An HTTP or SSE transport is a second implementation
  behind the same request/notify interface, added when a server that needs one
  shows up. The interface itself is package-internal and is not a published
  extension point.
- The tool catalog is fetched once, at connect time, following `nextCursor`
  across pages. A server that changes its tools later
  (`notifications/tools/list_changed`) is not re-polled; reconnect to refresh.
- A timed-out or interrupted `tools/call` sends one `notifications/cancelled`
  for its request id, because every MCP flow is declared `irreversible` and an
  abandoned in-flight mutation is a durability problem. `initialize` is never
  cancelled.
- Resources, prompts, sampling, and roots are not implemented. Add them to
  `McpClient` when a flow adapter needs them, not speculatively.
